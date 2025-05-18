// Chat Auto Backup 插件 - 自动保存和恢复聊天记录 (文件级操作优化)
// 主要功能：
// 1. 自动保存最近聊天记录到IndexedDB (通过后端API获取原始文件内容)
// 2. 在插件页面显示保存的记录
// 3. 提供恢复功能，将保存的聊天记录通过后端API导入/保存为新文件，然后加载
// 4. 移除Web Worker，直接通过API获取和保存数据

import {
    saveSettingsDebounced,
    getCurrentChatId,
    eventSource,
    event_types,
    messageFormatting,
    getRequestHeaders,
    characters,
    openCharacterChat,
    saveChatConditional
} from '../../../../script.js';

import {
    select_group_chats,
    selected_group,
    select_group_chats as selectGroupChatFile,
} from '../../../group-chats.js';

import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
} from '../../../extensions.js';

import {
    Popup,
    POPUP_TYPE,
    callGenericPopup,
    POPUP_RESULT,
} from '../../../popup.js';

import {
    timestampToMoment,
} from '../../../utils.js'

// 插件文件夹名称 (用于加载模板)
const pluginFolderName = 'chat-history-backupM3'; // 确保这里是你的实际文件夹名

// 插件的唯一 ID (用于日志和内部识别)
const pluginId = 'chat-backup-manager-ui';

// 备份管理器弹窗实例（用于后续关闭操作）
let backupManagerPopup = null;

// IndexedDB 数据库名称和版本
const DB_NAME = 'ST_ChatAutoBackup_v2'; // 使用新的数据库名称或版本以避免与旧数据冲突
const DB_VERSION = 1;
// 修改对象存储，以适应新的备份数据结构
const STORE_NAME = 'backups_v2';

// 备份状态控制
let isBackupInProgress = false; // 并发控制标志
let backupTimeout = null;       // 防抖定时器 ID

// --- 日志函数 ---
function logDebug(...args) {
    const settings = extension_settings[PLUGIN_NAME];
    if (settings && settings.debug) {
        console.log(`[${pluginId}][${new Date().toLocaleTimeString()}]`, ...args);
    }
}

// --- 设置初始化 ---
function initSettings() {
    logDebug('初始化插件设置');
    if (!extension_settings[PLUGIN_NAME]) {
        logDebug('创建新的插件设置');
        extension_settings[PLUGIN_NAME] = { ...DEFAULT_SETTINGS };
    }

    // 确保设置结构完整
    const settings = extension_settings[PLUGIN_NAME];

    // 确保所有设置都存在 (使用 ?? 运算符提供默认值)
    settings.maxTotalBackups = settings.maxTotalBackups ?? DEFAULT_SETTINGS.maxTotalBackups;
    settings.backupDebounceDelay = settings.backupDebounceDelay ?? DEFAULT_SETTINGS.backupDebounceDelay;
    settings.debug = settings.debug ?? DEFAULT_SETTINGS.debug;

    // 验证设置合理性
    if (typeof settings.maxTotalBackups !== 'number' || settings.maxTotalBackups < 1) {
        console.warn(`[${pluginId}] 无效的最大备份数 ${settings.maxTotalBackups}，重置为默认值 ${DEFAULT_SETTINGS.maxTotalBackups}`);
        settings.maxTotalBackups = DEFAULT_SETTINGS.maxTotalBackups;
    }

    if (typeof settings.backupDebounceDelay !== 'number' || settings.backupDebounceDelay < 300) {
        console.warn(`[${pluginId}] 无效的防抖延迟 ${settings.backupDebounceDelay}，重置为默认值 ${DEFAULT_SETTINGS.backupDebounceDelay}`);
        settings.backupDebounceDelay = DEFAULT_SETTINGS.backupDebounceDelay;
    }

    logDebug('插件设置初始化完成:', settings);
    return settings;
}

// --- IndexedDB 相关函数 (适应新结构) ---
// 初始化 IndexedDB 数据库
function initDatabase() {
    return new Promise((resolve, reject) => {
        logDebug('初始化 IndexedDB 数据库');
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = function(event) {
            console.error(`[${pluginId}] 打开数据库失败:`, event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = function(event) {
            const db = event.target.result;
            logDebug('数据库打开成功');
            resolve(db);
        };

        request.onupgradeneeded = function(event) {
            const db = event.target.result;
            console.log(`[${pluginId}] 数据库升级中 (版本 ${event.oldVersion} -> ${event.newVersion})`);
            // 如果是新创建或从旧版本升级，删除旧的存储并创建新的
            if (db.objectStoreNames.contains(STORE_NAME)) {
                db.deleteObjectStore(STORE_NAME);
                console.log(`[${pluginId}] 删除了旧的对象存储 ${STORE_NAME}`);
            }
            const store = db.createObjectStore(STORE_NAME, { keyPath: ['chatKey', 'timestamp'] });
            store.createIndex('chatKey', 'chatKey', { unique: false });
            console.log(`[${pluginId}] 创建了新的备份对象存储 ${STORE_NAME} 和索引`);
        };
    });
}

// 获取数据库连接 (使用连接池)
let dbConnection = null; // 连接池实例
async function getDB() {
    try {
        if (dbConnection && dbConnection.readyState !== 'closed') {
            return dbConnection;
        }
        dbConnection = await initDatabase();
        return dbConnection;
    } catch (error) {
        console.error(`[${pluginId}] 获取数据库连接失败:`, error);
        throw error;
    }
}


// 保存备份到 IndexedDB (适应新结构)
async function saveBackupToDB(backup) {
    const db = await getDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');

            transaction.oncomplete = () => {
                logDebug(`备份已保存到IndexedDB, 键: [${backup.chatKey}, ${backup.timestamp}]`);
                resolve();
            };

            transaction.onerror = (event) => {
                console.error(`[${pluginId}] 保存备份事务失败:`, event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
             // 使用 put() 覆盖或添加
            store.put(backup);
        });
    } catch (error) {
        console.error(`[${pluginId}] saveBackupToDB 失败:`, error);
        throw error;
    }
}

// 从 IndexedDB 获取指定备份 (适应新结构)
async function getBackupFromDB(chatKey, timestamp) {
     const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');

            transaction.onerror = (event) => {
                console.error(`[${pluginId}] 获取指定备份事务失败:`, event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            const request = store.get([chatKey, timestamp]);

            request.onsuccess = () => {
                logDebug(`从IndexedDB获取了备份，键: [${chatKey}, ${timestamp}]`, request.result);
                resolve(request.result);
            };

            request.onerror = (event) => {
                console.error(`[${pluginId}] 获取指定备份失败:`, event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error(`[${pluginId}] getBackupFromDB 失败:`, error);
        return null; // 出错时返回 null
    }
}


// 从 IndexedDB 获取指定聊天的所有备份 (适应新结构)
async function getBackupsForChat(chatKey) {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');

            transaction.onerror = (event) => {
                console.error(`[${pluginId}] 获取备份事务失败:`, event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('chatKey');
            const request = index.getAll(chatKey);

            request.onsuccess = () => {
                const backups = request.result || [];
                logDebug(`从IndexedDB获取了 ${backups.length} 个备份，chatKey: ${chatKey}`);
                resolve(backups);
            };

            request.onerror = (event) => {
                console.error(`[${pluginId}] 获取备份失败:`, event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error(`[${pluginId}] getBackupsForChat 失败:`, error);
        return []; // 出错时返回空数组
    }
}

// 从 IndexedDB 获取所有备份的主键 (适应新结构)
async function getAllBackupKeys() {
    const db = await getDB();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');

            transaction.onerror = (event) => {
                console.error(`[${pluginId}] 获取所有备份键事务失败:`, event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            const request = store.getAllKeys(); // 使用 getAllKeys() 只获取主键

            request.onsuccess = () => {
                const keys = request.result || [];
                logDebug(`从IndexedDB获取了总共 ${keys.length} 个备份的主键`);
                resolve(keys);
            };

            request.onerror = (event) => {
                console.error(`[${pluginId}] 获取所有备份键失败:`, event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error(`[${pluginId}] getAllBackupKeys 失败:`, error);
        return []; // 出错时返回空数组
    }
}

// 从 IndexedDB 删除指定备份
async function deleteBackup(chatKey, timestamp) {
    const db = await getDB();
    try {
        await new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');

            transaction.oncomplete = () => {
                logDebug(`已从IndexedDB删除备份, 键: [${chatKey}, ${timestamp}]`);
                resolve();
            };

            transaction.onerror = (event) => {
                console.error(`[${pluginId}] 删除备份事务失败:`, event.target.error);
                reject(event.target.error);
            };

            const store = transaction.objectStore(STORE_NAME);
            store.delete([chatKey, timestamp]);
        });
    } catch (error) {
        console.error(`[${pluginId}] deleteBackup 失败:`, error);
        throw error;
    }
}


// --- 聊天信息获取 (保持不变) ---
function getCurrentChatKey() {
    const context = getContext();
    // logDebug('获取当前聊天标识符, context:',
    //     {groupId: context.groupId, characterId: context.characterId, chatId: context.chatId}); // 避免过度日志
    if (context.groupId) {
        const key = `group_${context.groupId}_${context.chatId}`;
        // logDebug('当前是群组聊天，chatKey:', key);
        return key;
    } else if (context.characterId !== undefined && context.chatId) { // 确保chatId存在
        const key = `char_${context.characterId}_${context.chatId}`;
        // logDebug('当前是角色聊天，chatKey:', key);
        return key;
    }
    // console.warn(`[${pluginId}] 无法获取当前聊天的有效标识符 (可能未选择角色/群组或聊天)`);
    return null;
}

function getCurrentChatInfo() {
    const context = getContext();
    let chatName = '当前聊天', entityName = '未知实体', entityId = null, isGroup = false;

    if (context.groupId) {
        isGroup = true;
        entityId = context.groupId;
        const group = groups?.find(g => g.id === context.groupId);
        entityName = group ? group.name : `群组 ${context.groupId}`;
        chatName = context.chatId || '新聊天';
        // logDebug('获取到群组聊天信息:', {entityName, chatName, entityId});
    } else if (context.characterId !== undefined) {
        isGroup = false;
        entityId = String(context.characterId); // 角色ID是数字，转换为字符串方便统一处理
        entityName = context.name2 || `角色 ${context.characterId}`;
        const character = characters?.[context.characterId];
        if (character && context.chatId) {
             const chatFile = character.chat || context.chatId;
             chatName = chatFile.substring(chatFile.lastIndexOf('/') + 1).replace('.jsonl', '');
        } else {
            chatName = context.chatId || '新聊天';
        }
        // logDebug('获取到角色聊天信息:', {entityName, chatName, entityId});
    } else {
        // console.warn(`[${pluginId}] 无法获取聊天实体信息，使用默认值`);
    }

    return { entityName, chatName, entityId, isGroup };
}


// --- 核心备份逻辑封装 (使用后端API获取文件内容) ---
async function executeBackupLogic_Core(settings) {
    const currentTimestamp = Date.now();
    logDebug(`开始执行核心备份逻辑 @ ${new Date(currentTimestamp).toLocaleTimeString()}`);

    const chatKey = getCurrentChatKey();
    if (!chatKey) {
        console.warn(`[${pluginId}] 无有效的聊天标识符，跳过备份`);
        return false;
    }

    const { entityName, chatName, entityId, isGroup } = getCurrentChatInfo();
     const context = getContext(); // 再次获取上下文，确保最新

    if (!context.chat || context.chat.length === 0) {
         logDebug('当前聊天内容为空，跳过备份');
         return false;
    }

    const lastMsgIndex = context.chat.length - 1;
    const lastMessage = context.chat[lastMsgIndex];
    const lastMessagePreview = lastMessage?.mes?.substring(0, 100) || '(空消息)';

    logDebug(`准备备份聊天: ${entityName} - ${chatName}, 消息数: ${context.chat.length}, 最后消息ID: ${lastMsgIndex}`);

    let rawChatData = null; // 将存储从API获取的原始数据

    try {
        // 1. 通过后端API获取当前聊天文件的原始内容
        if (isGroup) {
            // 群组聊天：获取消息数组，并单独获取元数据
            logDebug(`通过 API 获取群组聊天消息: ${entityId} - ${context.chatId}`);
            const messagesResponse = await fetch('/api/chats/group/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ id: context.chatId }), // 群组API使用chat_id作为id
            });
            if (!messagesResponse.ok) {
                throw new Error(`获取群组聊天消息失败! 状态: ${messagesResponse.status}`);
            }
            rawChatData = await messagesResponse.json(); // 这是消息数组

            // 获取群组元数据 (通常在 group 对象中)
            const group = groups?.find(g => g.id === entityId);
            const groupMetadata = group?.chat_metadata || {}; // 使用chat_metadata属性
             logDebug('获取到群组元数据:', groupMetadata);

             // 将消息和元数据一起存储（或分开，取决于IndexedDB结构设计）
             // 这里选择分开存储，恢复时再组合
             rawChatData = { messages: rawChatData, metadata: groupMetadata };


        } else {
            // 角色聊天：获取包含元数据和消息的数组
            logDebug(`通过 API 获取角色聊天文件内容: ${entityName} - ${context.chatId}`);
            const character = characters?.[context.characterId];
            if (!character) throw new Error(`找不到角色 ${context.characterId} 的信息`);

            const chatFile = character.chat || context.chatId; // 确保有文件名

            const fileContentResponse = await fetch('/api/chats/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    ch_name: character.name,
                    file_name: chatFile, // 文件名 (不带.jsonl)
                    avatar_url: character.avatar,
                }),
            });
            if (!fileContentResponse.ok) {
                throw new Error(`获取角色聊天文件内容失败! 状态: ${fileContentResponse.status}`);
            }
            rawChatData = await fileContentResponse.json(); // 这是 [metadata, message1, ...] 数组

             // 验证数据结构
             if (!Array.isArray(rawChatData) || rawChatData.length === 0 || !rawChatData[0].chat_metadata) {
                 console.warn(`[${pluginId}] 获取的角色聊天数据结构异常，可能不是标准的 [metadata, messages...] 格式`, rawChatData);
                 // 尝试从 context 获取元数据作为回退
                 const fallbackMetadata = context.chatMetadata || {};
                 if (rawChatData.length === 0) {
                     rawChatData = [fallbackMetadata]; // 只有元数据
                 } else {
                     rawChatData[0] = rawChatData[0].chat_metadata ? rawChatData[0] : fallbackMetadata; // 尝试替换或添加元数据
                 }
             }
        }

        if (!rawChatData) {
             throw new Error("未能从API获取有效的聊天数据");
        }
         logDebug('从API成功获取到原始聊天数据');


        // 2. 构建备份对象 (适应新结构)
        const backup = {
            timestamp: currentTimestamp,
            chatKey,
            entityName,
            chatName,
            entityId, // 保存实体ID
            isGroup,  // 保存是否群组
            lastMessageId: lastMsgIndex,
            lastMessagePreview,
            // 存储原始数据
            rawChatData: isGroup ? rawChatData.messages : rawChatData, // 消息数组或 [metadata, messages]
            groupMetadata: isGroup ? rawChatData.metadata : undefined, // 仅群组需要单独存储元数据
        };
        logDebug('构建备份对象:', backup);


        // 3. 检查当前聊天是否已有基于最后消息ID的备份 (避免完全相同的备份)
        const existingBackups = await getBackupsForChat(chatKey); // 获取当前聊天的备份

        // 4. 检查重复并处理 (基于 lastMessageId) - 逻辑保持不变
        const existingBackupIndex = existingBackups.findIndex(b => b.lastMessageId === lastMsgIndex);
        let needsSave = true;

        if (existingBackupIndex !== -1) {
            const existingTimestamp = existingBackups[existingBackupIndex].timestamp;
            if (backup.timestamp > existingTimestamp) {
                logDebug(`发现具有相同最后消息ID (${lastMsgIndex}) 的旧备份 (时间戳 ${existingTimestamp})，将删除旧备份以便保存新备份 (时间戳 ${backup.timestamp})`);
                await deleteBackup(chatKey, existingTimestamp);
            } else {
                logDebug(`发现具有相同最后消息ID (${lastMsgIndex}) 且时间戳更新或相同的备份 (时间戳 ${existingTimestamp} vs ${backup.timestamp})，跳过本次保存`);
                needsSave = false;
            }
        }

        if (!needsSave) {
            logDebug('备份已存在或无需更新 (基于lastMessageId和时间戳比较)，跳过保存和全局清理步骤');
            return false;
        }

        // 5. 保存新备份到 IndexedDB
        await saveBackupToDB(backup);
        logDebug(`新备份已保存: [${chatKey}, ${backup.timestamp}]`);

        // --- 优化后的清理逻辑 ---
        // 6. 获取所有备份的 *主键* 并限制总数量 - 逻辑保持不变
        const allBackupKeys = await getAllBackupKeys();

        if (allBackupKeys.length > settings.maxTotalBackups) {
            logDebug(`总备份数 (${allBackupKeys.length}) 超出系统限制 (${settings.maxTotalBackups})`);
            allBackupKeys.sort((a, b) => a[1] - b[1]); // 按时间戳升序排序键
            const numToDelete = allBackupKeys.length - settings.maxTotalBackups;
            const keysToDelete = allBackupKeys.slice(0, numToDelete);

            logDebug(`准备删除 ${keysToDelete.length} 个最旧的备份 (基于键)`);
            await Promise.all(keysToDelete.map(key => deleteBackup(key[0], key[1])));
            logDebug(`${keysToDelete.length} 个旧备份已删除`);
        } else {
            logDebug(`总备份数 (${allBackupKeys.length}) 未超出限制 (${settings.maxTotalBackups})，无需清理`);
        }
        // --- 清理逻辑结束 ---

        // 7. UI提示 (外部处理)
        logDebug(`成功完成聊天备份及可能的清理: ${entityName} - ${chatName}`);
        return true; // 表示备份成功（或已跳过但无错误）

    } catch (error) {
        console.error(`[${pluginId}] 备份过程中发生错误:`, error);
        throw error; // 抛出错误，让外部调用者处理提示
    } finally {
        // 确保锁被释放 (由调用 performBackupConditional 的地方处理)
    }
}


// --- 条件备份函数 ---
async function performBackupConditional() {
    if (isBackupInProgress) {
        logDebug('备份已在进行中，跳过本次请求');
        return;
    }

    const context = getContext();
    const chatKey = getCurrentChatKey();

    // 只有在有有效的聊天标识符且有消息时才执行备份
    if (!chatKey || !context.chat || context.chat.length === 0) {
         // logDebug('无有效的聊天标识符或聊天为空，跳过条件备份'); // 避免频繁日志
         return false;
    }

    // 获取当前设置，包括防抖延迟
    const currentSettings = extension_settings[PLUGIN_NAME];
    if (!currentSettings) {
        console.error(`[${pluginId}] 无法获取当前设置，取消备份`);
        return false;
    }

    isBackupInProgress = true;
    logDebug('设置备份锁');
    try {
        // 调用核心备份逻辑 (不再传递 chat 和 metadata，核心逻辑自己获取)
        const success = await executeBackupLogic_Core(currentSettings);
        if (success) {
            // 如果备份成功（或有更新），刷新列表
            await updateBackupsList();
        }
        return success;
    } catch (error) {
        console.error(`[${pluginId}] 条件备份执行失败:`, error);
        toastr.error(`备份失败: ${error.message || '未知错误'}`, pluginId);
        return false;
    } finally {
        isBackupInProgress = false;
        logDebug('释放备份锁');
    }
}

// --- 防抖备份函数 ---
function performBackupDebounced() {
    // 获取调用时的上下文和设置
    const scheduledChatKey = getCurrentChatKey();
    const currentSettings = extension_settings[PLUGIN_NAME];

    if (!scheduledChatKey) {
        // logDebug('无法获取计划防抖备份时的 ChatKey，取消'); // 避免频繁日志
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }

    if (!currentSettings || typeof currentSettings.backupDebounceDelay !== 'number') {
        console.error(`[${pluginId}] 无法获取有效的防抖延迟设置，取消防抖`);
        clearTimeout(backupTimeout);
        backupTimeout = null;
        return;
    }

    const delay = currentSettings.backupDebounceDelay;

    // logDebug(`计划执行防抖备份 (延迟 ${delay}ms), 针对 ChatKey: ${scheduledChatKey}`); // 避免频繁日志
    clearTimeout(backupTimeout); // 清除旧的定时器

    backupTimeout = setTimeout(async () => {
        const currentChatKey = getCurrentChatKey(); // 获取执行时的 ChatKey

        // 关键: 上下文检查，确保在延迟结束后仍然是同一个聊天
        if (currentChatKey !== scheduledChatKey) {
            logDebug(`上下文已更改 (当前: ${currentChatKey}, 计划时: ${scheduledChatKey})，取消此防抖备份`);
            backupTimeout = null;
            return; // 中止备份
        }

        logDebug(`执行延迟的备份操作 (来自防抖), ChatKey: ${currentChatKey}`);
        // 只有上下文匹配时才执行条件备份
        await performBackupConditional();
        backupTimeout = null; // 清除定时器 ID
    }, delay);
}

// --- 手动备份 ---
async function performManualBackup() {
    console.log(`[${pluginId}] 执行手动备份 (调用条件函数)`);
    // 手动备份也走条件检查和锁逻辑
    try {
        const success = await performBackupConditional();
        if (success) {
             toastr.success('已手动备份当前聊天', pluginId);
        } else {
             // 如果 conditional 返回 false (例如，聊天为空或重复)，也给个提示
             toastr.info('手动备份已跳过 (聊天为空或无新变化)', pluginId);
        }
    } catch (error) {
         // 错误已经在 conditional 函数中处理并提示，这里不再重复
    }
}


// --- 恢复逻辑 (使用后端API导入/保存文件) ---
// restoreBackup 函数现在直接接收从 IndexedDB 获取的备份对象
async function restoreBackup(backupData) {
    logDebug('开始恢复备份:', { chatKey: backupData.chatKey, timestamp: backupData.timestamp });

    if (!backupData || (!backupData.rawChatData && !backupData.groupMetadata)) {
        console.error(`[${pluginId}] 备份数据无效或不完整`, backupData);
        toastr.error('备份数据无效或不完整');
        return false;
    }

    const confirmSave = await callGenericPopup(
        '您确定要恢复备份吗？当前聊天中未保存的修改将会丢失。',
        POPUP_TYPE.CONFIRM,
        null,
        {
            okButton: '恢复并保存当前',
            cancelButton: '取消',
            customButtons: [{ text: '恢复不保存', result: 2 }],
            defaultResult: POPUP_RESULT.AFFIRMATIVE
        }
    );

    if (confirmSave === POPUP_RESULT.CANCELLED) {
        logDebug('用户取消恢复操作');
        return false;
    }

    if (confirmSave === POPUP_RESULT.AFFIRMATIVE) {
        logDebug('用户选择保存当前聊天');
        await saveChatConditional(); // 使用条件保存
    } else if (confirmSave === 2) {
        logDebug('用户选择不保存当前聊天');
    } else {
         console.warn(`[${pluginId}] 收到未知的确认结果: ${confirmSave}`);
         return false;
    }

    try {
        const { entityId, isGroup, rawChatData, groupMetadata } = backupData;
        let targetEntityId = entityId; // 恢复到备份时对应的实体ID

        // 1. 切换到目标实体 (如果当前不是)
        const initialContext = getContext();
        const needsContextSwitch = (isGroup && initialContext.groupId !== targetEntityId) ||
                                   (!isGroup && String(initialContext.characterId) !== targetEntityId); // 角色ID是数字，比较时注意类型

        if (needsContextSwitch) {
            try {
                logDebug(`步骤 1: 需要切换上下文到 ${isGroup ? '群组' : '角色'} ID: ${targetEntityId}`);
                if (isGroup) {
                    await select_group_chats(targetEntityId);
                } else {
                     // 角色ID在备份中是字符串，需要转回数字索引
                     const charIndex = characters.findIndex(char => String(char.id) === targetEntityId || String(characters.indexOf(char)) === targetEntityId);
                     if (charIndex === -1) {
                         throw new Error(`找不到 ID 或索引为 ${targetEntityId} 的目标角色`);
                     }
                    await selectCharacterById(charIndex, { switchMenu: false });
                    targetEntityId = String(charIndex); // 更新为当前索引，方便后续检查
                }
                await new Promise(resolve => setTimeout(resolve, 800)); // 等待切换完成和UI稳定
                logDebug('步骤 1: 上下文切换完成');
            } catch (switchError) {
                console.error(`[${pluginId}] 步骤 1 失败: 切换到目标实体失败:`, switchError);
                toastr.error(`切换到目标${isGroup ? '群组' : '角色'}失败: ${switchError.message || switchError}`);
                return false;
            }
        } else {
            logDebug('步骤 1: 当前已在目标上下文，跳过切换');
             // 如果是角色，确保 targetEntityId 是当前的索引字符串
            if (!isGroup && initialContext.characterId !== undefined) {
                 targetEntityId = String(initialContext.characterId);
            }
        }

        // 2. 将备份数据构造成标准 .jsonl 格式字符串
        logDebug('步骤 2: 将备份数据构造成 .jsonl 格式字符串...');
        let jsonlString = '';
        let metadataToImport = {};
        let messagesToImport = [];

        if (isGroup) {
             // 群组备份：元数据和消息分开存储
            metadataToImport = groupMetadata || {};
            messagesToImport = rawChatData || []; // rawChatData 是消息数组
            jsonlString += JSON.stringify(metadataToImport) + '\n';
            messagesToImport.forEach(msg => {
                jsonlString += JSON.stringify(msg) + '\n';
            });
        } else {
            // 角色备份：rawChatData 是 [metadata, messages...] 数组
            if (Array.isArray(rawChatData) && rawChatData.length > 0) {
                 metadataToImport = rawChatData[0]?.chat_metadata || {};
                 messagesToImport = rawChatData.slice(1) || [];
                 jsonlString += JSON.stringify({ chat_metadata: metadataToImport }) + '\n'; // 确保顶层是 { chat_metadata: {...} }
                 messagesToImport.forEach(msg => {
                     jsonlString += JSON.stringify(msg) + '\n';
                 });
            } else {
                 throw new Error("角色备份数据结构异常，无法构建 .jsonl");
            }
        }
        logDebug(`步骤 2: .jsonl 字符串构建完成 (${messagesToImport.length} 条消息)`);


        // 3. 将 .jsonl 字符串转换为 File 对象
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const restoredFilename = `${backupData.entityName.replace(/\s+/g, '_')}_restored_${timestamp}.jsonl`; // 使用实体名和时间戳
        const chatFileObject = new File([jsonlString], restoredFilename, { type: "application/json-lines" });
        logDebug('步骤 3: .jsonl 字符串转换为 File 对象完成:', chatFileObject);

        // 4. 调用后端导入 API
        logDebug('步骤 4: 调用后端导入 API...');
        const formData = new FormData();
        formData.append('file', chatFileObject);
        formData.append('file_type', 'jsonl');

        let importUrl = '';
        let newChatIdAfterImport = null; // 保存导入成功后的新chatId

        if (isGroup) {
            importUrl = '/api/chats/group/import';
            formData.append('group_id', targetEntityId); // 目标群组ID
            // 导入API会返回新创建的聊天ID，我们需要捕获它
        } else {
             // 角色导入API (/api/chats/import) 似乎只导入角色卡，没有直接导入聊天文件的API到现有角色
             // 我们需要使用 /api/chats/save 来保存备份数据为新文件，然后打开
             // 这里不走导入API，直接走保存+打开流程
             logDebug('步骤 4 (角色): 不使用导入API，直接走保存+打开流程');
        }

        if (isGroup) {
             // 群组：使用导入API
             try {
                const response = await fetch(importUrl, {
                    method: 'POST',
                    headers: getRequestHeaders(), // FormData 会自动设置 Content-Type
                    body: formData,
                });

                if (!response.ok) {
                    const errorData = await response.json();
                    throw new Error(`群组聊天导入API调用失败! 状态: ${response.status} - ${errorData.error || '未知错误'}`);
                }
                const importResult = await response.json();
                logDebug(`步骤 4: 群组导入API响应:`, importResult);

                if (importResult.res) { // importResult.res 是新创建的聊天ID
                    newChatIdAfterImport = importResult.res;
                    logDebug(`步骤 4: 群组导入成功，新聊天ID: ${newChatIdAfterImport}`);
                } else {
                    throw new Error('群组聊天导入API未返回预期的聊天ID。');
                }
            } catch (error) {
                console.error(`[${pluginId}] 步骤 4 失败: 群组导入API调用出错:`, error);
                throw new Error(`群组聊天导入失败: ${error.message || error}`);
            }

        } else {
            // 角色：使用保存API将备份数据保存为新文件
            const character = characters.find(char => String(characters.indexOf(char)) === targetEntityId || String(char.id) === targetEntityId);
            if (!character) throw new Error(`找不到索引或ID为 ${targetEntityId} 的目标角色信息`);

            const newChatIdForRole = restoredFilename.replace('.jsonl', ''); // 使用生成的文件名作为chatId

            try {
                logDebug(`步骤 4 (角色): 尝试将备份内容保存为新聊天文件: ${newChatIdForRole}.jsonl`);
                const saveResponse = await fetch('/api/chats/save', {
                    method: 'POST',
                    headers: getRequestHeaders(),
                    body: JSON.stringify({
                        ch_name: character.name,
                        file_name: newChatIdForRole, // 新文件名
                        chat: [{ chat_metadata: metadataToImport }, ...messagesToImport], // 构造 [metadata, messages...] 数组
                        avatar_url: character.avatar,
                        force: true // 强制保存，覆盖同名文件（如果需要）
                    }),
                });

                if (!saveResponse.ok) {
                    const errorData = await saveResponse.json();
                     throw new Error(`保存角色聊天文件失败! 状态: ${saveResponse.status} - ${errorData.error || '未知错误'}`);
                }
                logDebug(`步骤 4 (角色): 新聊天文件 ${newChatIdForRole}.jsonl 应已保存。`);
                newChatIdAfterImport = newChatIdForRole; // 保存的文件名就是新的chatId

            } catch (error) {
                 console.error(`[${pluginId}] 步骤 4 失败: 保存角色聊天文件出错:`, error);
                 throw new Error(`保存角色聊天文件失败: ${error.message || error}`);
            }
        }


        // 5. 加载新创建/导入的聊天
        logDebug('步骤 5: 加载新创建/导入的聊天...');
        if (newChatIdAfterImport) {
            try {
                if (isGroup) {
                    await select_group_chats(targetEntityId, newChatIdAfterImport); // 加载指定群组的指定聊天
                } else {
                    await openCharacterChat(newChatIdAfterImport); // 加载指定角色下的指定聊天文件
                }
                 // 延迟等待加载和插件初始化
                await new Promise(resolve => setTimeout(resolve, 3000)); // 保持一个较长的延迟

                logDebug('步骤 5: 新聊天加载完成');

            } catch (loadError) {
                 console.error(`[${pluginId}] 步骤 5 失败: 加载新创建/导入的聊天时出错:`, loadError);
                 throw new Error(`加载恢复的聊天失败: ${loadError.message || loadError}`);
            }
        } else {
            throw new Error("未能获取新创建/导入聊天的ID");
        }


        // --- 结束 ---
        logDebug('恢复流程完成');
        toastr.success('聊天备份已成功恢复！', pluginId);
        // 刷新备份列表UI，可能新文件会出现在列表中
        updateBackupsList();
        // 关闭弹窗
        if (backupManagerPopup) {
            backupManagerPopup.dlg.close();
        }
        return true;

    } catch (error) {
        console.error(`[${pluginId}] 恢复聊天过程中发生未预料的严重错误:`, error);
        toastr.error(`恢复失败: ${error.message || '未知错误'}`, pluginId);
        // 可以在这里尝试切换回之前的聊天，但可能会引入新的复杂性
        return false;
    }
}


// --- UI 更新 (适应新结构) ---
async function updateBackupsList() {
    logDebug('开始更新备份列表UI');
    const backupsContainer = $('#chat_backup_list');
    if (!backupsContainer.length) {
        console.warn(`[${pluginId}] 找不到备份列表容器元素 #chat_backup_list`);
        return;
    }

    backupsContainer.html('<div class="backup_empty_notice">正在加载备份...</div>');

    try {
        const allBackupKeys = await getAllBackupKeys(); // 先获取所有键
        const allBackupsPromises = allBackupKeys.map(key => getBackupFromDB(key[0], key[1]));
        const allBackups = await Promise.all(allBackupsPromises);

        // 过滤掉加载失败的备份 (null)
        const validBackups = allBackups.filter(backup => backup !== null);


        backupsContainer.empty(); // 清空

        if (validBackups.length === 0) {
            backupsContainer.append('<div class="backup_empty_notice">暂无保存的备份</div>');
            return;
        }

        // 按时间降序排序
        validBackups.sort((a, b) => b.timestamp - a.timestamp);
        logDebug(`渲染 ${validBackups.length} 个备份`);

        validBackups.forEach(backup => {
            const date = new Date(backup.timestamp);
            const formattedDate = date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });

            const backupItem = $(`
                <div class="backup_item">
                    <div class="backup_info">
                        <div class="backup_header">
                            <span class="backup_entity" title="${backup.entityName}">${backup.entityName || '未知实体'}</span>
                            <span class="backup_chat" title="${backup.chatName}">${backup.chatName || '未知聊天'}</span>
                        </div>
                         <div class="backup_details">
                            <span class="backup_mesid">消息数: ${backup.lastMessageId + 1}</span>
                            <span class="backup_date">${formattedDate}</span>
                        </div>
                        <div class="backup_preview" title="${backup.lastMessagePreview}">${backup.lastMessagePreview}...</div>
                    </div>
                    <div class="backup_actions">
                        <button class="menu_button backup_preview_btn" title="预览此备份的最后两条消息" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">预览</button>
                        <button class="menu_button backup_restore" title="恢复此备份到新聊天" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">恢复</button>
                        <button class="menu_button danger_button backup_delete" title="删除此备份" data-timestamp="${backup.timestamp}" data-key="${backup.chatKey}">删除</button>
                    </div>
                </div>
            `);
            backupsContainer.append(backupItem);
        });

        logDebug('备份列表渲染完成');
    } catch (error) {
        console.error(`[${pluginId}] 更新备份列表失败:`, error);
        backupsContainer.html(`<div class="backup_empty_notice">加载备份列表失败: ${error.message}</div>`);
    }
}


// --- 预览功能 (适应新结构) ---
async function previewBackup(chatKey, timestamp) {
    logDebug(`点击预览按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

    try {
        const backup = await getBackupFromDB(chatKey, timestamp);

        if (!backup) {
             console.error(`[${pluginId}] 找不到指定的备份进行预览:`, { timestamp, chatKey });
             toastr.error('找不到指定的备份进行预览');
             return;
        }

        let messagesToPreview = [];
        let totalMessages = 0;

        if (backup.isGroup) {
             messagesToPreview = backup.rawChatData || []; // 群组备份直接是消息数组
             totalMessages = messagesToPreview.length;
        } else {
             // 角色备份是 [metadata, messages...]
             if (Array.isArray(backup.rawChatData) && backup.rawChatData.length > 1) {
                 messagesToPreview = backup.rawChatData.slice(1); // 跳过元数据
                 totalMessages = messagesToPreview.length;
             } else {
                 messagesToPreview = [];
                 totalMessages = 0;
             }
        }


        if (totalMessages === 0) {
            toastr.info('此备份没有聊天消息内容可供预览', pluginId);
            return;
        }

        // 获取最后两条消息
        const lastMessages = messagesToPreview.slice(-2);

        // 过滤标签并处理Markdown - 保持不变
        const processMessage = (messageText) => {
            if (!messageText) return '(空消息)';

            let processed = messageText
                .replace(/<think>[\s\S]*?<\/think>/g, '')
                .replace(/<thinking>[\s\\S]*?<\/thinking>/g, ''); // 修正regex

            processed = processed
                .replace(/```[\s\S]*?```/g, '')
                .replace(/`[\s\S]*?`/g, '');

            processed = processed
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.*?)\*/g, '<em>$1</em>')
                .replace(/\n\n+/g, '\n')
                .replace(/\n/g, '<br>');

            return processed;
        };

        // 创建样式和预览内容 - 保持不变
        const style = document.createElement('style');
        style.textContent = `
            .message_box {
                padding: 10px;
                margin-bottom: 10px;
                border-radius: 8px;
                background: rgba(0, 0, 0, 0.15);
            }
            .message_sender {
                font-weight: bold;
                margin-bottom: 5px;
                color: var(--SmColor);
            }
            .message_content {
                white-space: pre-wrap;
                line-height: 1.4;
            }
            .message_content br + br {
                margin-top: 0.5em;
            }
        `;

        const previewContent = document.createElement('div');
        previewContent.appendChild(style);

        const headerDiv = document.createElement('h3');
        headerDiv.textContent = `${backup.entityName} - ${backup.chatName} 预览`;
        previewContent.appendChild(headerDiv);

        // 为每条消息创建单独的盒子
        lastMessages.forEach(msg => {
            const messageBox = document.createElement('div');
            messageBox.className = 'message_box';

            const senderDiv = document.createElement('div');
            senderDiv.className = 'message_sender';
            senderDiv.textContent = msg.name || '未知';

            const contentDiv = document.createElement('div');
            contentDiv.className = 'message_content';
            contentDiv.innerHTML = processMessage(msg.mes);

            messageBox.appendChild(senderDiv);
            messageBox.appendChild(contentDiv);

            previewContent.appendChild(messageBox);
        });

        const footerDiv = document.createElement('div');
        footerDiv.style.marginTop = '10px';
        footerDiv.style.opacity = '0.7';
        footerDiv.style.fontSize = '0.9em';
        footerDiv.textContent = `显示最后 ${lastMessages.length} 条消息，共 ${totalMessages} 条`;
        previewContent.appendChild(footerDiv);

        // 使用系统弹窗显示预览内容
        // 导入对话框系统 (确保已导入 popup.js)
        // const { callGenericPopup, POPUP_TYPE } = await import('../../../popup.js'); // 已在顶部导入

        await callGenericPopup(previewContent, POPUP_TYPE.DISPLAY, '', {
            wide: true,
            allowVerticalScrolling: true,
            leftAlign: true,
            okButton: '关闭'
        });

    } catch (error) {
        console.error(`[${pluginId}] 预览过程中出错:`, error);
        toastr.error(`预览过程中出错: ${error.message || error}`);
    }
}


// --- UI 注入 ---
jQuery(async () => {
    logDebug('DOM 已加载，开始注入 UI 元素。');

    const $optionsMenu = $('#options');
    if ($optionsMenu.length) {
        const $backupButton = $(`
            <div id="option_manage_backups" class="menu_button">
                <span>聊天备份</span>
            </div>
        `);

        const $selectChatButton = $('#option_select_chat');
        if ($selectChatButton.length) {
             $backupButton.insertAfter($selectChatButton);
             logDebug('已将“聊天备份”按钮注入到 Options 菜单。');
        } else {
            $optionsMenu.append($backupButton);
             logDebug('已将“聊天备份”按钮追加到 Options 菜单。');
        }

         logDebug('“聊天备份”按钮已创建，等待 APP_READY 事件绑定点击处理。');
    } else {
        console.warn(`[${pluginId}] 未找到 Options 菜单容器 (#options)，无法注入按钮。`);
    }
});

// --- 等待 APP_READY 事件并绑定需要核心功能依赖的事件 ---
eventSource.on(event_types.APP_READY, async () => {
    logDebug('收到 APP_READY 事件，SillyTavern 核心功能已准备就绪。');

    const $backupButton = $('#option_manage_backups');

    if ($backupButton.length) {
        $backupButton.on('click', async () => {
            // 调用函数打开弹窗
            await openBackupManagerPopup();
            // 隐藏 Options 菜单，如果它在弹窗下面
            $('#options').hide();
        });
        logDebug('已为“聊天备份”按钮绑定点击处理。');
    } else {
         console.warn(`[${pluginId}] 未找到“聊天备份”按钮 (#option_manage_backups)，无法绑定点击处理。`);
    }

     // 使用事件委托绑定弹窗内的按钮事件
     $(document).on('click', '.chat-backup-manager-popup .backup_restore', async function() {
        const button = $(this);
        const timestamp = parseInt(button.data('timestamp'));
        const chatKey = button.data('key');
        logDebug(`弹窗内点击恢复按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

        button.prop('disabled', true).text('恢复中...');

        try {
            const backup = await getBackupFromDB(chatKey, timestamp);
            if (backup) {
                // restoreBackup 函数内部会处理确认弹窗
                const success = await restoreBackup(backup);
                 // 恢复后不再需要手动 updateBackupsList，restoreBackup 内部会调用或导入API会处理
            } else {
                console.error(`[${pluginId}] 弹窗内找不到指定的备份进行恢复:`, { timestamp, chatKey });
                toastr.error('找不到指定的备份进行恢复');
            }
        } catch (error) {
            console.error(`[${pluginId}] 弹窗内恢复过程中出错:`, error);
            toastr.error(`恢复过程中出错: ${error.message || error}`);
        } finally {
            button.prop('disabled', false).text('恢复');
        }
    });

    $(document).on('click', '.chat-backup-manager-popup .backup_delete', async function() {
         const button = $(this);
         const timestamp = parseInt(button.data('timestamp'));
         const chatKey = button.data('key');
         logDebug(`弹窗内点击删除按钮, timestamp: ${timestamp}, chatKey: ${chatKey}`);

         const backupItem = button.closest('.backup_item');
         const entityName = backupItem.find('.backup_entity').text();
         const chatName = backupItem.find('.backup_chat').text();
         const date = backupItem.find('.backup_date').text();

         if (confirm(`确定要永久删除这个备份吗？\n\n实体: ${entityName}\n聊天: ${chatName}\n时间: ${date}\n\n此操作无法撤销！`)) {
             button.prop('disabled', true).text('删除中...');
             try {
                 await deleteBackup(chatKey, timestamp);
                 toastr.success('备份已删除', pluginId);
                 backupItem.fadeOut(300, function() {
                     $(this).remove();
                     // 检查列表是否为空，如果为空则显示提示
                     if ($('#chat_backup_list .backup_item').length === 0) {
                         $('#chat_backup_list').html('<div class="backup_empty_notice">暂无保存的备份</div>');
                     }
                 });

             } catch (error) {
                 console.error(`[${pluginId}] 弹窗内删除备份失败:`, error);
                 toastr.error(`删除备份失败: ${error.message || error}`, pluginId);
                 button.prop('disabled', false).text('删除');
             }
         }
    });

     $(document).on('click', '.chat-backup-manager-popup .backup_preview_btn', async function() {
        const button = $(this);
        const timestamp = parseInt(button.data('timestamp'));
        const chatKey = button.data('key');

        button.prop('disabled', true).text('加载中...');
        try {
            await previewBackup(chatKey, timestamp); // 调用预览函数
        } finally {
            button.prop('disabled', false).text('预览');
        }
     });


    logDebug('已为弹窗内部按钮设置事件委托。');
});


// --- 插件功能函数 ---

/**
 * 打开聊天备份管理弹窗
 */
async function openBackupManagerPopup() {
    logDebug('打开备份管理器弹窗...');

    // 获取当前的上下文（角色或群组）
    const context = getContext();
    const { entityName, isGroup, entityId } = getCurrentChatInfo();

    // 加载弹窗的 HTML 模板
    try {
        const popupHtml = await renderExtensionTemplateAsync(`third-party/${pluginFolderName}`, 'backup_manager_popup');

        // 使用 Popup 类创建并显示弹窗
        // 确保 onClose 回调正确清除引用
        if (backupManagerPopup) {
             backupManagerPopup.dlg.close(); // 如果已有弹窗，先关闭
        }
        backupManagerPopup = new Popup($(popupHtml), POPUP_TYPE.TEXT, null, {
            wide: true, large: true, allowVerticalScrolling: true,
            onClose: () => {
                 backupManagerPopup = null; // 清除引用
                 logDebug('备份管理器弹窗已关闭');
            }
        });

        // 设置弹窗标题
        const title = '聊天备份' + (entityName ? ` - ${entityName}` : '');
        backupManagerPopup.dlg.querySelector('#backup-manager-title').textContent = title;

        // 获取备份文件列表并填充到弹窗中
        if (entityId === null) {
            logDebug('未选中角色或群组，无法显示备份。');
            backupManagerPopup.dlg.querySelector('#backup-list-container').style.display = 'none';
            backupManagerPopup.dlg.querySelector('#no-entity-selected-message').style.display = 'block';
            backupManagerPopup.dlg.querySelector('#no-entity-selected-message p').textContent = '请先选择一个角色或群组来管理其聊天备份。';

        } else {
            backupManagerPopup.dlg.querySelector('#backup-list-container').style.display = 'block';
            backupManagerPopup.dlg.querySelector('#no-entity-selected-message').style.display = 'none';
            await updateBackupsList(); // 刷新列表
        }

        await backupManagerPopup.show();

    } catch (error) {
        console.error(`[${pluginId}] 打开备份管理器弹窗失败:`, error);
        callGenericPopup('无法加载备份管理器界面。', POPUP_TYPE.TEXT, null, { text: error.message || error });
    }
}


// --- 初始化与事件绑定 ---
jQuery(async () => {
    logDebug('插件加载中...');

    // 初始化设置
    const settings = initSettings();

    try {
        // 初始化数据库
        await initDatabase();
        logDebug('数据库初始化成功');

        // Web Worker 已移除，不再需要创建和绑定

        // 加载插件UI
        const settingsHtml = await renderExtensionTemplateAsync(
            `third-party/${pluginFolderName}`,
            'settings'
        );
        $('#extensions_settings').append(settingsHtml);
        logDebug('已添加设置界面');

        // 设置控制项 (保持不变)
        const $settingsBlock = $('<div class="chat_backup_control_item"></div>');
        $settingsBlock.html(`
            <div style="margin-bottom: 8px;">
                <label style="display: inline-block; min-width: 120px;">防抖延迟 (ms):</label>
                <input type="number" id="chat_backup_debounce_delay" value="${settings.backupDebounceDelay}"
                    min="300" max="10000" step="100" title="编辑或删除消息后，等待多少毫秒再执行备份 (建议 1000-1500)"
                    style="width: 80px;" />
            </div>
            <div>
                <label style="display: inline-block; min-width: 120px;">系统最大备份数:</label>
                <input type="number" id="chat_backup_max_total" value="${settings.maxTotalBackups}"
                    min="1" max="10" step="1" title="系统中保留的最大备份数量"
                    style="width: 80px;" />
            </div>
             <div style="margin-top: 8px;">
                <label style="display: inline-block; min-width: 120px;">调试模式:</label>
                <input type="checkbox" id="chat_backup_debug_toggle" ${settings.debug ? 'checked' : ''}>
            </div>
        `);
        $('.chat_backup_controls').prepend($settingsBlock);

        // 绑定设置项监听 (保持不变)
        $(document).on('input', '#chat_backup_max_total', function() {
            const total = parseInt($(this).val(), 10);
            if (!isNaN(total) && total >= 1 && total <= 10) { // 限制最大值
                settings.maxTotalBackups = total;
                logDebug(`系统最大备份数已更新为: ${total}`);
                saveSettingsDebounced();
            } else {
                // 恢复到合法值或默认值
                const validValue = Math.max(1, Math.min(10, isNaN(total) ? DEFAULT_SETTINGS.maxTotalBackups : total));
                $(this).val(validValue);
                settings.maxTotalBackups = validValue;
                logDebug(`无效或超出范围的系统最大备份数输入，已更正为: ${validValue}`);
                saveSettingsDebounced();
            }
        });

        $(document).on('input', '#chat_backup_debounce_delay', function() {
            const delay = parseInt($(this).val(), 10);
             if (!isNaN(delay) && delay >= 300 && delay <= 10000) { // 限制范围
                settings.backupDebounceDelay = delay;
                logDebug(`防抖延迟已更新为: ${delay}ms`);
                saveSettingsDebounced();
            } else {
                 // 恢复到合法值或默认值
                const validValue = Math.max(300, Math.min(10000, isNaN(delay) ? DEFAULT_SETTINGS.backupDebounceDelay : delay));
                $(this).val(validValue);
                settings.backupDebounceDelay = validValue;
                logDebug(`无效或超出范围的防抖延迟输入，已更正为: ${validValue}`);
                saveSettingsDebounced();
            }
        });

        $(document).on('change', '#chat_backup_debug_toggle', function() {
            settings.debug = $(this).prop('checked');
            console.log(`[${pluginId}] 调试模式已` + (settings.debug ? '启用' : '禁用'));
            saveSettingsDebounced();
        });


        // --- 设置事件监听 (保持不变) ---
        function setupBackupEvents() {
            const immediateBackupEvents = [
                event_types.MESSAGE_SENT,
                event_types.GENERATION_ENDED,
                event_types.CHARACTER_FIRST_MESSAGE_SELECTED,
            ].filter(Boolean);

            const debouncedBackupEvents = [
                event_types.MESSAGE_EDITED,
                event_types.MESSAGE_DELETED,
                event_types.MESSAGE_SWIPED,
                event_types.IMAGE_SWIPED,
                event_types.MESSAGE_FILE_EMBEDDED,
                event_types.MESSAGE_REASONING_EDITED,
                event_types.MESSAGE_REASONING_DELETED,
                event_types.FILE_ATTACHMENT_DELETED,
                event_types.GROUP_UPDATED,
            ].filter(Boolean);

            logDebug('设置立即备份事件监听:', immediateBackupEvents.map(e => Object.keys(event_types).find(key => event_types[key] === e) || e));
            immediateBackupEvents.forEach(eventType => {
                if (!eventType) return;
                eventSource.on(eventType, () => {
                    // logDebug(`事件触发 (立即备份): ${Object.keys(event_types).find(key => event_types[key] === eventType) || eventType}`);
                    performBackupConditional().catch(error => {
                        console.error(`[${pluginId}] 立即备份事件 ${eventType} 处理失败:`, error);
                    });
                });
            });

            logDebug('设置防抖备份事件监听:', debouncedBackupEvents.map(e => Object.keys(event_types).find(key => event_types[key] === e) || e));
            debouncedBackupEvents.forEach(eventType => {
                if (!eventType) return;
                eventSource.on(eventType, () => {
                    // logDebug(`事件触发 (防抖备份): ${Object.keys(event_types).find(key => event_types[key] === eventType) || eventType}`);
                    performBackupDebounced();
                });
            });

            logDebug('事件监听器设置完成');
        }

        setupBackupEvents();

        // 监听扩展页面打开事件，刷新列表
        $(document).on('click', '#extensionsMenuButton', () => {
            // 检查插件设置抽屉是否已打开或即将打开
            const settingsDrawer = $('#chat_auto_backup_settings').closest('.inline-drawer');
            if (settingsDrawer.length && settingsDrawer.hasClass('open')) {
                 logDebug('扩展菜单按钮点击，且插件设置抽屉已打开，刷新备份列表');
                 setTimeout(updateBackupsList, 50); // 稍作延迟确保面板内容已加载
            }
        });


        // 初始备份检查 (延迟执行，确保聊天已加载)
        setTimeout(async () => {
            logDebug('执行初始备份检查');
            const context = getContext();
            // 检查是否有当前聊天且有消息
            if (context.chat && context.chat.length > 0) {
                logDebug('发现现有聊天记录，执行初始备份');
                try {
                    await performBackupConditional(); // 使用条件函数
                } catch (error) {
                    console.error(`[${pluginId}] 初始备份执行失败:`, error);
                }
            } else {
                logDebug('当前没有聊天记录或备份进行中，跳过初始备份');
            }
        }, 4000); // 稍长延迟，等待应用完全初始化

        logDebug('插件加载完成');

    } catch (error) {
        console.error(`[${pluginId}] 插件加载过程中发生严重错误:`, error);
        $('#extensions_settings').append(
            `<div class="error">聊天自动备份插件加载失败，请检查控制台。<br>${error.message || error}</div>`
        );
    }
});
