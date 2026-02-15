/**
 * 反应模式
 * 红包随机闪现，3秒消失
 */

const { v4: uuidv4 } = require('uuid');
const { generateAmounts, generateBombs, calculateBombPenalty } = require('../utils/amount');
const { validateClick, clearClickHistory } = require('../utils/antiCheat');
const _ = require('lodash');

class ReactionMode {
  constructor(room) {
    this.room = room;
    this.packets = [];
    this.activePackets = new Map(); // 当前显示的红包
    this.gameTimer = null;
    this.spawnTimer = null;
    this.isEnded = false;
    this.grabCount = 0;
    this.comboMap = new Map();
    this.packetIndex = 0;
    this.amounts = [];
    this.bombs = [];
  }

  /**
   * 开始游戏
   */
  start() {
    const { settings } = this.room;
    
    // 生成红包金额
    this.amounts = generateAmounts(
      settings.amountType,
      settings.totalAmount,
      settings.packetCount,
      settings.amountConfig
    );

    // 生成炸弹标记
    this.bombs = generateBombs(
      settings.advanced?.bombRate || 0,
      settings.packetCount,
      settings.mechanics?.allowNegative
    );

    // 计算红包出现间隔
    const spawnSpeed = settings.advanced?.spawnSpeed || 1;
    const baseInterval = (settings.duration * 1000) / settings.packetCount;
    this.spawnInterval = baseInterval / spawnSpeed;

    // 广播游戏开始
    this.room.io.to(this.room.code).emit('gameStarted', {
      mode: 'reaction',
      settings: {
        duration: settings.duration,
        packetCount: settings.packetCount,
        showCursor: settings.mechanics?.showCursor || false,
        comboBonus: settings.mechanics?.comboBonus || false,
        spawnSpeed
      },
      packets: [], // 反应模式开始时没有红包
      round: 1,
      totalRounds: 1
    });

    // 开始生成红包
    this.spawnNextPacket();

    // 启动游戏计时器
    this.gameTimer = setTimeout(() => {
      this.endGame();
    }, settings.duration * 1000);

    console.log(`[反应模式] 房间 ${this.room.code} 游戏开始，间隔 ${this.spawnInterval}ms`);
  }

  /**
   * 生成下一个红包
   */
  spawnNextPacket() {
    if (this.isEnded || this.packetIndex >= this.room.settings.packetCount) {
      return;
    }

    const amount = this.amounts[this.packetIndex];
    const isBomb = this.bombs[this.packetIndex];

    const packet = {
      id: uuidv4(),
      x: Math.random() * 700 + 50,
      y: Math.random() * 400 + 100,
      amount,
      isBomb,
      grabbedBy: null,
      spawnTime: Date.now(),
      disappearTime: Date.now() + 3000 // 3秒后消失
    };

    this.packets.push(packet);
    this.activePackets.set(packet.id, packet);

    // 广播红包出现
    this.room.io.to(this.room.code).emit('packetSpawned', {
      packetId: packet.id,
      x: packet.x,
      y: packet.y,
      amount: this.room.settings.amountType === 'memory' ? null : amount,
      isBomb: false, // 反应模式不显示是否是炸弹
      disappearIn: 3000
    });

    // 设置消失定时器
    setTimeout(() => {
      this.disappearPacket(packet.id);
    }, 3000);

    this.packetIndex++;

    // 安排下一个红包
    if (this.packetIndex < this.room.settings.packetCount) {
      this.spawnTimer = setTimeout(() => {
        this.spawnNextPacket();
      }, this.spawnInterval);
    }
  }

  /**
   * 红包消失
   */
  disappearPacket(packetId) {
    const packet = this.activePackets.get(packetId);
    if (!packet || packet.grabbedBy) return;

    this.activePackets.delete(packetId);

    // 广播红包消失
    this.room.io.to(this.room.code).emit('packetDisappeared', {
      packetId,
      reason: 'timeout'
    });
  }

  /**
   * 处理抢红包
   */
  grabPacket(playerId, packetId, clickData) {
    if (this.isEnded) return null;

    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return null;

    const packet = this.activePackets.get(packetId);
    if (!packet) return null;

    // 检查红包是否已被抢
    if (packet.grabbedBy) {
      return null;
    }

    // 防作弊验证
    const validation = validateClick(player, packet, clickData, this.room.settings);
    if (!validation.valid) {
      console.log(`[防作弊] 玩家 ${player.name} 点击无效: ${validation.reason}`);
      return null;
    }

    // 标记红包被抢
    packet.grabbedBy = playerId;
    packet.grabbedAt = Date.now();
    this.activePackets.delete(packetId);
    this.grabCount++;

    // 计算得分
    let amount = packet.amount;
    let isBomb = packet.isBomb;
    let combo = 0;

    if (isBomb) {
      const penalty = calculateBombPenalty(
        amount,
        this.room.settings.mechanics?.allowNegative,
        player.score
      );
      amount = -penalty;
      this.comboMap.set(playerId, 0);
    } else {
      player.score += amount;

      // 连击计算
      if (this.room.settings.mechanics?.comboBonus) {
        const currentCombo = (this.comboMap.get(playerId) || 0) + 1;
        this.comboMap.set(playerId, currentCombo);
        combo = currentCombo;

        if (combo % 3 === 0) {
          const bonus = Math.round(amount * 0.1 * 100) / 100;
          amount += bonus;
          player.score += bonus;
        }
      }
    }

    if (isBomb) {
      player.score = Math.max(0, player.score + amount);
    }

    player.grabCount = (player.grabCount || 0) + 1;
    if (isBomb) {
      player.bombCount = (player.bombCount || 0) + 1;
    }

    return {
      player: {
        id: player.id,
        name: player.name,
        score: player.score
      },
      packetId,
      amount: packet.amount,
      finalAmount: amount,
      isBomb,
      combo,
      reactionTime: packet.grabbedAt - packet.spawnTime,
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
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
    }

    const stats = this.calculateStats();
    const winner = _.maxBy(this.room.players, 'score');

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

    this.room.players.forEach(p => clearClickHistory(p.id));

    console.log(`[反应模式] 房间 ${this.room.code} 游戏结束`);
  }

  /**
   * 计算统计
   */
  calculateStats() {
    const allGrabs = this.grabCount;
    const bombGrabs = this.packets.filter(p => p.isBomb && p.grabbedBy).length;
    const missedPackets = this.packets.filter(p => !p.grabbedBy).length;

    // 计算平均反应时间
    let totalReactionTime = 0;
    let reactionCount = 0;
    this.packets.forEach(p => {
      if (p.grabbedAt && p.spawnTime) {
        totalReactionTime += p.grabbedAt - p.spawnTime;
        reactionCount++;
      }
    });
    const avgReactionTime = reactionCount > 0 ? Math.round(totalReactionTime / reactionCount) : 0;
    
    let maxCombo = 0;
    this.comboMap.forEach((combo) => {
      maxCombo = Math.max(maxCombo, combo);
    });

    return {
      totalPackets: this.packets.length,
      grabbedPackets: allGrabs,
      missedPackets,
      bombPackets: this.packets.filter(p => p.isBomb).length,
      bombTriggered: bombGrabs,
      maxCombo,
      avgReactionTime,
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
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
    }
    this.isEnded = true;
  }
}

module.exports = ReactionMode;
