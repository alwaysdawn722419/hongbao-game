/**
 * 微信红包大作战游戏服务器
 * 支持2-20人，高度自定义参数
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// 导入游戏模式
const SpeedMode = require('./modes/speed');
const MemoryMode = require('./modes/memory');
const ReactionMode = require('./modes/reaction');
const TeamMode = require('./modes/team');

// 导入工具函数
const { validateSettings } = require('./utils/antiCheat');

// 创建Express应用
const app = express();
app.use(cors());
app.use(express.json());

// 创建HTTP服务器
const server = http.createServer(app);

// 创建Socket.io服务器
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

// 房间存储
const rooms = new Map();

// 生成房间码
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// 默认游戏设置
const defaultSettings = {
  totalAmount: 100,
  packetCount: 10,
  duration: 30,
  amountType: 'random', // random, fixed, range, equal
  amountConfig: {},
  mechanics: {
    showCursor: false,
    allowNegative: false,
    comboBonus: false,
    luckyProtection: false,
    teamFriendlyFire: false
  },
  advanced: {
    bombRate: 0,
    spawnSpeed: 1,
    skillCDMultiplier: 1
  },
  totalRounds: 1
};

// 创建房间
function createRoom(playerName, mode, customSettings) {
  const code = generateRoomCode();
  
  // 合并设置
  const settings = {
    ...defaultSettings,
    ...customSettings,
    mechanics: {
      ...defaultSettings.mechanics,
      ...customSettings?.mechanics
    },
    advanced: {
      ...defaultSettings.advanced,
      ...customSettings?.advanced
    }
  };

  // 验证设置
  const validation = validateSettings(settings);
  if (!validation.valid) {
    return { error: validation.errors.join(', ') };
  }

  const hostId = uuidv4();
  
  const room = {
    code,
    mode, // speed, memory, reaction, team
    state: 'waiting', // waiting, playing, ended
    host: hostId,
    players: [{
      id: hostId,
      name: playerName,
      score: 0,
      combo: 0,
      grabCount: 0,
      bombCount: 0,
      isHost: true
    }],
    settings,
    gameInstance: null,
    createdAt: Date.now()
  };

  rooms.set(code, room);
  console.log(`[创建房间] ${code} - ${mode}模式 - 房主: ${playerName}`);
  
  return { room, hostId };
}

// 加入房间
function joinRoom(roomCode, playerName) {
  const room = rooms.get(roomCode.toUpperCase());
  
  if (!room) {
    return { error: '房间不存在' };
  }

  if (room.state !== 'waiting') {
    return { error: '游戏已开始' };
  }

  if (room.players.length >= 20) {
    return { error: '房间已满' };
  }

  // 检查重名
  const existingPlayer = room.players.find(p => p.name === playerName);
  if (existingPlayer) {
    return { error: '该昵称已被使用' };
  }

  const playerId = uuidv4();
  const player = {
    id: playerId,
    name: playerName,
    score: 0,
    combo: 0,
    grabCount: 0,
    bombCount: 0,
    isHost: false
  };

  // 团队战模式分配队伍
  if (room.mode === 'team') {
    const redCount = room.players.filter(p => p.team === 'red').length;
    const blueCount = room.players.filter(p => p.team === 'blue').length;
    player.team = redCount <= blueCount ? 'red' : 'blue';
  }

  room.players.push(player);
  console.log(`[加入房间] ${roomCode} - ${playerName} (${room.players.length}人)`);

  return { room, playerId, player };
}

// 更新房间设置
function updateSettings(roomCode, newSettings, playerId) {
  const room = rooms.get(roomCode.toUpperCase());
  
  if (!room) {
    return { error: '房间不存在' };
  }

  // 只有房主可以修改设置
  const player = room.players.find(p => p.id === playerId);
  if (!player || !player.isHost) {
    return { error: '只有房主可以修改设置' };
  }

  if (room.state !== 'waiting') {
    return { error: '游戏已开始，无法修改设置' };
  }

  // 合并新设置
  room.settings = {
    ...room.settings,
    ...newSettings,
    mechanics: {
      ...room.settings.mechanics,
      ...newSettings?.mechanics
    },
    advanced: {
      ...room.settings.advanced,
      ...newSettings?.advanced
    }
  };

  // 验证设置
  const validation = validateSettings(room.settings);
  if (!validation.valid) {
    return { error: validation.errors.join(', ') };
  }

  console.log(`[更新设置] ${roomCode}`);
  return { success: true, settings: room.settings };
}

// 开始游戏
function startGame(roomCode, playerId) {
  const room = rooms.get(roomCode.toUpperCase());
  
  if (!room) {
    return { error: '房间不存在' };
  }

  const player = room.players.find(p => p.id === playerId);
  if (!player || !player.isHost) {
    return { error: '只有房主可以开始游戏' };
  }

  if (room.state === 'playing') {
    return { error: '游戏进行中' };
  }

  // 2人即可开局
  if (room.players.length < 2) {
    return { error: '至少需要2人才能开始游戏' };
  }

  room.state = 'playing';

  // 重置玩家分数
  room.players.forEach(p => {
    p.score = 0;
    p.combo = 0;
    p.grabCount = 0;
    p.bombCount = 0;
  });

  // 创建游戏实例
  switch (room.mode) {
    case 'speed':
      room.gameInstance = new SpeedMode({ ...room, io });
      break;
    case 'memory':
      room.gameInstance = new MemoryMode({ ...room, io });
      break;
    case 'reaction':
      room.gameInstance = new ReactionMode({ ...room, io });
      break;
    case 'team':
      room.gameInstance = new TeamMode({ ...room, io });
      break;
    default:
      return { error: '未知的游戏模式' };
  }

  // 启动游戏
  room.gameInstance.start();

  console.log(`[开始游戏] ${roomCode} - ${room.mode}模式 - ${room.players.length}人`);
  return { success: true };
}

// 清理过期房间（每30分钟）
setInterval(() => {
  const now = Date.now();
  const expireTime = 30 * 60 * 1000; // 30分钟

  rooms.forEach((room, code) => {
    if (now - room.createdAt > expireTime && room.state === 'waiting') {
      rooms.delete(code);
      console.log(`[清理房间] ${code} - 已过期`);
    }
  });
}, 5 * 60 * 1000); // 每5分钟检查一次

// Socket.io连接处理
io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  let currentRoom = null;
  let currentPlayerId = null;

  // 创建房间
  socket.on('createRoom', ({ playerName, mode, settings }, callback) => {
    const result = createRoom(playerName, mode, settings);
    
    if (result.error) {
      callback({ error: result.error });
      return;
    }

    const { room, hostId } = result;
    currentRoom = room.code;
    currentPlayerId = hostId;

    socket.join(room.code);
    
    callback({
      success: true,
      roomCode: room.code,
      playerId: hostId,
      settings: room.settings,
      isCustomized: true
    });

    // 广播房间创建
    socket.to(room.code).emit('roomCreated', {
      roomCode: room.code,
      settings: room.settings,
      isCustomized: true
    });
  });

  // 加入房间
  socket.on('joinRoom', ({ roomCode, playerName }, callback) => {
    const result = joinRoom(roomCode, playerName);
    
    if (result.error) {
      callback({ error: result.error });
      return;
    }

    const { room, playerId, player } = result;
    currentRoom = room.code;
    currentPlayerId = playerId;

    socket.join(room.code);

    callback({
      success: true,
      roomCode: room.code,
      playerId,
      settings: room.settings,
      players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, team: p.team }))
    });

    // 广播玩家加入
    socket.to(room.code).emit('playerJoined', {
      player: { id: playerId, name: playerName, isHost: false, team: player.team },
      players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, team: p.team })),
      count: room.players.length,
      minToStart: 2,
      canStart: room.players.length >= 2
    });
  });

  // 更新设置
  socket.on('updateSettings', ({ roomCode, settings }, callback) => {
    const result = updateSettings(roomCode, settings, currentPlayerId);
    
    if (result.error) {
      callback({ error: result.error });
      return;
    }

    callback({ success: true, settings: result.settings });

    // 广播设置更新
    io.to(roomCode).emit('settingsUpdated', {
      settings: result.settings
    });
  });

  // 选择角色（团队战）
  socket.on('selectRole', ({ roomCode, role }, callback) => {
    const room = rooms.get(roomCode.toUpperCase());
    if (!room || !room.gameInstance) {
      callback({ error: '游戏未开始' });
      return;
    }

    if (room.mode !== 'team') {
      callback({ error: '当前模式不支持角色选择' });
      return;
    }

    const result = room.gameInstance.selectRole(currentPlayerId, role);
    callback(result || { success: true });
  });

  // 使用技能
  socket.on('useSkill', ({ roomCode, target }, callback) => {
    const room = rooms.get(roomCode.toUpperCase());
    if (!room || !room.gameInstance) {
      callback({ error: '游戏未开始' });
      return;
    }

    if (room.mode !== 'team') {
      callback({ error: '当前模式不支持技能' });
      return;
    }

    const result = room.gameInstance.useSkill(currentPlayerId, target);
    callback(result || { success: true });
  });

  // 使用团队技能
  socket.on('useTeamSkill', ({ roomCode, skillId }, callback) => {
    const room = rooms.get(roomCode.toUpperCase());
    if (!room || !room.gameInstance) {
      callback({ error: '游戏未开始' });
      return;
    }

    if (room.mode !== 'team') {
      callback({ error: '当前模式不支持团队技能' });
      return;
    }

    const result = room.gameInstance.useTeamSkill(currentPlayerId, skillId);
    callback(result || { success: true });
  });

  // 开始游戏
  socket.on('startGame', ({ roomCode }, callback) => {
    const result = startGame(roomCode, currentPlayerId);
    callback(result);
  });

  // 抢红包
  socket.on('grabPacket', ({ roomCode, packetId, timestamp, pos }, callback) => {
    const room = rooms.get(roomCode.toUpperCase());
    if (!room || !room.gameInstance) {
      callback({ error: '游戏未开始' });
      return;
    }

    const result = room.gameInstance.grabPacket(currentPlayerId, packetId, { timestamp, pos });
    
    if (result) {
      // 广播红包被抢
      io.to(roomCode).emit('packetGrabbed', result);
    }

    callback(result ? { success: true } : { error: '抢红包失败' });
  });

  // 更新光标位置
  socket.on('updateCursor', ({ roomCode, x, y }) => {
    const room = rooms.get(roomCode.toUpperCase());
    if (!room || !room.gameInstance) return;

    room.gameInstance.updateCursor(currentPlayerId, { x, y });
  });

  // 下一回合（团队战）
  socket.on('nextRound', ({ roomCode }, callback) => {
    const room = rooms.get(roomCode.toUpperCase());
    if (!room || !room.gameInstance) {
      callback({ error: '游戏未开始' });
      return;
    }

    const player = room.players.find(p => p.id === currentPlayerId);
    if (!player || !player.isHost) {
      callback({ error: '只有房主可以操作' });
      return;
    }

    // 团队战自动进行回合，这里只是确认
    callback({ success: true });
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log(`[断开] ${socket.id}`);

    if (currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        // 移除玩家
        const playerIndex = room.players.findIndex(p => p.id === currentPlayerId);
        if (playerIndex > -1) {
          const player = room.players[playerIndex];
          room.players.splice(playerIndex, 1);

          console.log(`[离开房间] ${currentRoom} - ${player.name}`);

          // 如果房间空了，删除房间
          if (room.players.length === 0) {
            if (room.gameInstance) {
              room.gameInstance.cleanup();
            }
            rooms.delete(currentRoom);
            console.log(`[删除房间] ${currentRoom}`);
          } else {
            // 如果房主离开，转让房主
            if (player.isHost && room.players.length > 0) {
              room.players[0].isHost = true;
              room.host = room.players[0].id;
            }

            // 广播玩家离开
            io.to(currentRoom).emit('playerLeft', {
              playerId: currentPlayerId,
              playerName: player.name,
              players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost })),
              count: room.players.length,
              newHost: room.players[0]?.id
            });
          }
        }
      }
    }
  });
});

// HTTP API

// 获取房间信息
app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code.toUpperCase());
  if (!room) {
    return res.status(404).json({ error: '房间不存在' });
  }

  res.json({
    code: room.code,
    mode: room.mode,
    state: room.state,
    playerCount: room.players.length,
    players: room.players.map(p => ({ id: p.id, name: p.name, isHost: p.isHost, team: p.team })),
    settings: room.settings
  });
});

// 获取房间列表（调试用）
app.get('/api/rooms', (req, res) => {
  const roomList = [];
  rooms.forEach((room, code) => {
    roomList.push({
      code,
      mode: room.mode,
      state: room.state,
      playerCount: room.players.length
    });
  });
  res.json(roomList);
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    rooms: rooms.size,
    uptime: process.uptime()
  });
});

// 前端页面
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 静态文件
app.use(express.static(path.join(__dirname, 'public')));

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║                                                            ║
║     🧧 微信红包大作战游戏服务器 - 高度自定义版              ║
║                                                            ║
║     端口: ${PORT}                                          ║
║     模式: 手速 | 记忆 | 反应 | 团队战                       ║
║     人数: 2-20人                                           ║
║                                                            ║
╚════════════════════════════════════════════════════════════╝
  `);
});

// 错误处理
process.on('uncaughtException', (err) => {
  console.error('[未捕获的异常]', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[未处理的Promise拒绝]', reason);
});

module.exports = { app, server, io };
