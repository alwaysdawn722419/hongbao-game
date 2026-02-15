/**
 * 手速模式
 * 红包同时出现，比拼点击速度
 */

const { v4: uuidv4 } = require('uuid');
const { generateAmounts, generateBombs, calculateBombPenalty } = require('../utils/amount');
const { validateClick, clearClickHistory } = require('../utils/antiCheat');
const _ = require('lodash');

class SpeedMode {
  constructor(room) {
    this.room = room;
    this.packets = [];
    this.gameTimer = null;
    this.isEnded = false;
    this.grabCount = 0;
    this.comboMap = new Map(); // 玩家连击记录
  }

  /**
   * 开始游戏
   */
  start() {
    const { settings } = this.room;
    
    // 生成红包金额
    const amounts = generateAmounts(
      settings.amountType,
      settings.totalAmount,
      settings.packetCount,
      settings.amountConfig
    );

    // 生成炸弹标记
    const bombs = generateBombs(
      settings.advanced?.bombRate || 0,
      settings.packetCount,
      settings.mechanics?.allowNegative
    );

    // 创建红包对象
    this.packets = amounts.map((amount, index) => ({
      id: uuidv4(),
      x: Math.random() * 700 + 50, // 50-750 随机位置
      y: Math.random() * 400 + 100, // 100-500 随机位置
      amount,
      isBomb: bombs[index],
      grabbedBy: null,
      spawnTime: Date.now()
    }));

    // 广播游戏开始
    this.room.io.to(this.room.code).emit('gameStarted', {
      mode: 'speed',
      settings: {
        duration: settings.duration,
        packetCount: settings.packetCount,
        showCursor: settings.mechanics?.showCursor || false,
        comboBonus: settings.mechanics?.comboBonus || false
      },
      packets: this.packets.map(p => ({
        id: p.id,
        x: p.x,
        y: p.y,
        amount: settings.amountType === 'memory' ? null : p.amount, // 手速模式显示金额
        isBomb: p.isBomb
      })),
      round: 1,
      totalRounds: 1
    });

    // 启动游戏计时器
    this.gameTimer = setTimeout(() => {
      this.endGame();
    }, settings.duration * 1000);

    console.log(`[手速模式] 房间 ${this.room.code} 游戏开始，${settings.packetCount} 个红包`);
  }

  /**
   * 处理抢红包
   */
  grabPacket(playerId, packetId, clickData) {
    if (this.isEnded) return null;

    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return null;

    const packet = this.packets.find(p => p.id === packetId);
    if (!packet) return null;

    // 防作弊验证
    const validation = validateClick(player, packet, clickData, this.room.settings);
    if (!validation.valid) {
      console.log(`[防作弊] 玩家 ${player.name} 点击无效: ${validation.reason}`);
      return null;
    }

    // 标记红包被抢
    packet.grabbedBy = playerId;
    this.grabCount++;

    // 计算得分
    let amount = packet.amount;
    let isBomb = packet.isBomb;
    let combo = 0;

    if (isBomb) {
      // 炸弹红包
      const penalty = calculateBombPenalty(
        amount,
        this.room.settings.mechanics?.allowNegative,
        player.score
      );
      amount = -penalty;
      this.comboMap.set(playerId, 0); // 连击中断
    } else {
      // 普通红包
      player.score += amount;

      // 连击计算
      if (this.room.settings.mechanics?.comboBonus) {
        const currentCombo = (this.comboMap.get(playerId) || 0) + 1;
        this.comboMap.set(playerId, currentCombo);
        combo = currentCombo;

        // 连击加成：每连击3次，额外获得10%
        if (combo % 3 === 0) {
          const bonus = Math.round(amount * 0.1 * 100) / 100;
          amount += bonus;
          player.score += bonus;
        }
      }
    }

    // 更新玩家分数
    if (isBomb) {
      player.score = Math.max(0, player.score + amount);
    }

    player.grabCount = (player.grabCount || 0) + 1;
    if (isBomb) {
      player.bombCount = (player.bombCount || 0) + 1;
    }

    // 检查是否所有红包都被抢完
    if (this.grabCount >= this.packets.length) {
      this.endGame();
    }

    return {
      player: {
        id: player.id,
        name: player.name,
        score: player.score
      },
      packetId,
      amount: isBomb ? amount : packet.amount,
      finalAmount: amount,
      isBomb,
      combo,
      totalGrabbed: this.grabCount
    };
  }

  /**
   * 更新玩家光标位置
   */
  updateCursor(playerId, pos) {
    if (!this.room.settings.mechanics?.showCursor) return;
    
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    // 广播给其他玩家
    this.room.io.to(this.room.code).emit('playerCursor', {
      playerId,
      playerName: player.name,
      x: pos.x,
      y: pos.y
    });
  }

  /**
   * 结束游戏
   */
  endGame() {
    if (this.isEnded) return;
    this.isEnded = true;

    if (this.gameTimer) {
      clearTimeout(this.gameTimer);
    }

    // 计算统计数据
    const stats = this.calculateStats();

    // 确定获胜者
    const winner = _.maxBy(this.room.players, 'score');

    // 广播游戏结束
    this.room.io.to(this.room.code).emit('gameEnded', {
      winner: winner ? {
        id: winner.id,
        name: winner.name,
        score: winner.score
      } : null,
      finalScores: this.room.players.map(p => ({
        id: p.id,
        name: p.name,
        score: p.score,
        grabCount: p.grabCount || 0,
        bombCount: p.bombCount || 0,
        maxCombo: this.comboMap.get(p.id) || 0
      })),
      stats
    });

    // 清理
    this.room.players.forEach(p => clearClickHistory(p.id));

    console.log(`[手速模式] 房间 ${this.room.code} 游戏结束，获胜者: ${winner?.name}`);
  }

  /**
   * 计算统计
   */
  calculateStats() {
    const allGrabs = this.grabCount;
    const bombGrabs = this.packets.filter(p => p.isBomb && p.grabbedBy).length;
    
    let maxCombo = 0;
    this.comboMap.forEach((combo) => {
      maxCombo = Math.max(maxCombo, combo);
    });

    return {
      totalPackets: this.packets.length,
      grabbedPackets: allGrabs,
      bombPackets: this.packets.filter(p => p.isBomb).length,
      bombTriggered: bombGrabs,
      maxCombo,
      duration: this.room.settings.duration
    };
  }

  /**
   * 清理资源
   */
  cleanup() {
    if (this.gameTimer) {
      clearTimeout(this.gameTimer);
    }
    this.isEnded = true;
  }
}

module.exports = SpeedMode;
