/**
 * 团队战模式
 * 2v2起，红蓝对抗+角色技能+炸弹红包
 */

const { v4: uuidv4 } = require('uuid');
const { generateAmounts, generateBombs, calculateBombPenalty } = require('../utils/amount');
const { validateClick, clearClickHistory, getSkillCooldown } = require('../utils/antiCheat');
const _ = require('lodash');

// 角色定义
const ROLES = {
  striker: {
    name: '突击手',
    description: '点击速度+50%，持续5秒',
    cooldown: 15000,
    duration: 5000,
    passive: false
  },
  disruptor: {
    name: '干扰者',
    description: '使敌方1人界面模糊3秒',
    cooldown: 20000,
    duration: 3000,
    passive: false
  },
  scout: {
    name: '侦察兵',
    description: '显示所有红包金额3秒',
    cooldown: 25000,
    duration: 3000,
    passive: false
  },
  guardian: {
    name: '守护者',
    description: '免疫干扰并反弹',
    cooldown: 0,
    passive: true
  },
  lucky: {
    name: '幸运星',
    description: '下3个红包保底5元',
    cooldown: 30000,
    duration: null,
    passive: false
  }
};

// 团队技能
const TEAM_SKILLS = [
  { id: 'rain', name: '红包雨', description: '额外生成5个红包' },
  { id: 'double', name: '金额翻倍', description: '下5个红包金额翻倍' },
  { id: 'disrupt', name: '敌方干扰', description: '敌方全体模糊2秒' }
];

class TeamMode {
  constructor(room) {
    this.room = room;
    this.packets = [];
    this.activePackets = new Map();
    this.gameTimer = null;
    this.spawnTimer = null;
    this.isEnded = false;
    this.grabCount = 0;
    this.comboMap = new Map();
    this.packetIndex = 0;
    this.amounts = [];
    this.bombs = [];
    this.currentRound = 1;
    this.teamScores = { red: 0, blue: 0 };
    this.teamPacketCount = { red: 0, blue: 0 }; // 用于团队技能
    this.activeEffects = new Map(); // 玩家当前效果
    this.doubleActive = false; // 金额翻倍激活
    this.doubleCount = 0;
  }

  /**
   * 分配队伍
   */
  assignTeams(autoAssign = true) {
    if (autoAssign) {
      // 奇偶分配
      this.room.players.forEach((player, index) => {
        player.team = index % 2 === 0 ? 'red' : 'blue';
      });
    }
  }

  /**
   * 开始游戏
   */
  start() {
    // 分配队伍
    this.assignTeams(true);

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
      mode: 'team',
      settings: {
        duration: settings.duration,
        packetCount: settings.packetCount,
        showCursor: settings.mechanics?.showCursor || false,
        comboBonus: settings.mechanics?.comboBonus || false,
        teamFriendlyFire: settings.mechanics?.teamFriendlyFire || false,
        spawnSpeed
      },
      teams: {
        red: this.room.players.filter(p => p.team === 'red').map(p => ({ id: p.id, name: p.name })),
        blue: this.room.players.filter(p => p.team === 'blue').map(p => ({ id: p.id, name: p.name }))
      },
      roles: ROLES,
      teamSkills: TEAM_SKILLS,
      packets: [],
      round: this.currentRound,
      totalRounds: settings.totalRounds || 1
    });

    // 开始生成红包
    this.spawnNextPacket();

    // 启动游戏计时器
    this.gameTimer = setTimeout(() => {
      this.endRound();
    }, settings.duration * 1000);

    console.log(`[团队战] 房间 ${this.room.code} 第${this.currentRound}局开始`);
  }

  /**
   * 生成下一个红包
   */
  spawnNextPacket() {
    if (this.isEnded || this.packetIndex >= this.room.settings.packetCount) {
      return;
    }

    let amount = this.amounts[this.packetIndex];
    const isBomb = this.bombs[this.packetIndex];

    // 金额翻倍效果
    if (this.doubleActive && this.doubleCount < 5) {
      amount *= 2;
      this.doubleCount++;
      if (this.doubleCount >= 5) {
        this.doubleActive = false;
      }
    }

    const packet = {
      id: uuidv4(),
      x: Math.random() * 700 + 50,
      y: Math.random() * 400 + 100,
      amount,
      isBomb,
      grabbedBy: null,
      spawnTime: Date.now(),
      disappearTime: Date.now() + 3000
    };

    this.packets.push(packet);
    this.activePackets.set(packet.id, packet);

    // 广播红包出现
    this.room.io.to(this.room.code).emit('packetSpawned', {
      packetId: packet.id,
      x: packet.x,
      y: packet.y,
      amount: null, // 团队战默认隐藏金额
      isBomb: false,
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

    // 检查同队抢夺（如果关闭友军伤害）
    if (!this.room.settings.mechanics?.teamFriendlyFire && packet.grabbedBy) {
      const grabber = this.room.players.find(p => p.id === packet.grabbedBy);
      if (grabber && grabber.team === player.team) {
        return null;
      }
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

    // 幸运星效果
    if (player.role === 'lucky' && player.luckyCount > 0) {
      amount = Math.max(amount, 5);
      player.luckyCount--;
    }

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
      this.teamScores[player.team] += amount;

      // 团队技能计数
      this.teamPacketCount[player.team]++;

      // 连击计算
      if (this.room.settings.mechanics?.comboBonus) {
        const currentCombo = (this.comboMap.get(playerId) || 0) + 1;
        this.comboMap.set(playerId, currentCombo);
        combo = currentCombo;

        if (combo % 3 === 0) {
          const bonus = Math.round(amount * 0.1 * 100) / 100;
          amount += bonus;
          player.score += bonus;
          this.teamScores[player.team] += bonus;
        }
      }
    }

    if (isBomb) {
      player.score = Math.max(0, player.score + amount);
      this.teamScores[player.team] = Math.max(0, this.teamScores[player.team] + amount);
    }

    player.grabCount = (player.grabCount || 0) + 1;
    if (isBomb) {
      player.bombCount = (player.bombCount || 0) + 1;
    }

    // 检查团队技能
    this.checkTeamSkill(player.team);

    return {
      player: {
        id: player.id,
        name: player.name,
        team: player.team,
        score: player.score
      },
      packetId,
      amount: packet.amount,
      finalAmount: amount,
      isBomb,
      combo,
      teamScores: this.teamScores,
      teamPacketCount: this.teamPacketCount,
      reactionTime: packet.grabbedAt - packet.spawnTime,
      totalGrabbed: this.grabCount
    };
  }

  /**
   * 检查团队技能是否激活
   */
  checkTeamSkill(team) {
    if (this.teamPacketCount[team] >= 5) {
      this.teamPacketCount[team] = 0;
      // 通知该队可以激活团队技能
      const teamPlayers = this.room.players.filter(p => p.team === team);
      teamPlayers.forEach(p => {
        this.room.io.to(p.id).emit('teamSkillReady', {
          team,
          skills: TEAM_SKILLS
        });
      });
    }
  }

  /**
   * 使用团队技能
   */
  useTeamSkill(playerId, skillId) {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return null;

    const team = player.team;
    const enemyTeam = team === 'red' ? 'blue' : 'red';

    switch (skillId) {
      case 'rain':
        // 红包雨：额外生成5个红包
        for (let i = 0; i < 5; i++) {
          setTimeout(() => {
            this.spawnBonusPacket();
          }, i * 500);
        }
        break;

      case 'double':
        // 金额翻倍
        this.doubleActive = true;
        this.doubleCount = 0;
        break;

      case 'disrupt':
        // 敌方干扰
        const enemyPlayers = this.room.players.filter(p => p.team === enemyTeam);
        enemyPlayers.forEach(p => {
          this.applyEffect(p.id, 'blurred', 2000);
        });
        break;
    }

    // 广播技能使用
    this.room.io.to(this.room.code).emit('teamSkillUsed', {
      player: { id: player.id, name: player.name, team },
      skill: TEAM_SKILLS.find(s => s.id === skillId),
      targetTeam: skillId === 'disrupt' ? enemyTeam : null
    });

    return { success: true };
  }

  /**
   * 生成额外红包（红包雨）
   */
  spawnBonusPacket() {
    if (this.isEnded) return;

    const amount = Math.random() * 10 + 1;
    const packet = {
      id: uuidv4(),
      x: Math.random() * 700 + 50,
      y: Math.random() * 400 + 100,
      amount,
      isBomb: false,
      grabbedBy: null,
      spawnTime: Date.now(),
      disappearTime: Date.now() + 3000,
      isBonus: true
    };

    this.packets.push(packet);
    this.activePackets.set(packet.id, packet);

    this.room.io.to(this.room.code).emit('packetSpawned', {
      packetId: packet.id,
      x: packet.x,
      y: packet.y,
      amount: null,
      isBomb: false,
      disappearIn: 3000,
      isBonus: true
    });

    setTimeout(() => {
      this.disappearPacket(packet.id);
    }, 3000);
  }

  /**
   * 选择角色
   */
  selectRole(playerId, roleId) {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return null;

    // 检查角色是否已被选择
    const takenRoles = this.room.players
      .filter(p => p.id !== playerId && p.role)
      .map(p => p.role);
    
    if (takenRoles.includes(roleId)) {
      return { error: '该角色已被选择' };
    }

    if (!ROLES[roleId]) {
      return { error: '无效的角色' };
    }

    player.role = roleId;
    player.luckyCount = roleId === 'lucky' ? 3 : 0;

    // 广播角色选择
    this.room.io.to(this.room.code).emit('roleSelected', {
      playerId,
      playerName: player.name,
      role: roleId,
      roleInfo: ROLES[roleId]
    });

    return { success: true, role: ROLES[roleId] };
  }

  /**
   * 使用个人技能
   */
  useSkill(playerId, targetId) {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player || !player.role) return { error: '未选择角色' };

    const role = ROLES[player.role];
    if (!role) return { error: '无效的角色' };

    // 检查冷却
    if (player.lastSkillTime) {
      const cd = getSkillCooldown(player.role, this.room.settings);
      const elapsed = Date.now() - player.lastSkillTime;
      if (elapsed < cd) {
        return { error: `技能冷却中，还需 ${Math.ceil((cd - elapsed) / 1000)} 秒` };
      }
    }

    // 被动技能不能主动使用
    if (role.passive) {
      return { error: '被动技能无法主动使用' };
    }

    player.lastSkillTime = Date.now();

    switch (player.role) {
      case 'striker':
        // 突击手：点击速度+50%
        this.applyEffect(playerId, 'speedBoost', role.duration, { multiplier: 1.5 });
        break;

      case 'disruptor':
        // 干扰者：使敌方1人模糊
        if (targetId) {
          const target = this.room.players.find(p => p.id === targetId);
          if (target && target.team !== player.team) {
            // 检查目标是否是守护者
            if (target.role === 'guardian') {
              // 反弹干扰
              this.applyEffect(playerId, 'blurred', role.duration);
            } else {
              this.applyEffect(targetId, 'blurred', role.duration);
            }
          }
        }
        break;

      case 'scout':
        // 侦察兵：显示所有红包金额
        this.activePackets.forEach((packet, packetId) => {
          this.room.io.to(playerId).emit('packetRevealed', {
            packetId,
            amount: packet.amount,
            isBomb: packet.isBomb
          });
        });
        break;

      case 'lucky':
        // 幸运星：下3个保底5元
        player.luckyCount = 3;
        break;
    }

    // 广播技能使用
    this.room.io.to(this.room.code).emit('skillUsed', {
      player: { id: player.id, name: player.name, team: player.team },
      skill: player.role,
      skillName: role.name,
      target: targetId,
      effect: role.description
    });

    return { success: true };
  }

  /**
   * 应用效果
   */
  applyEffect(playerId, effectType, duration, data = {}) {
    const player = this.room.players.find(p => p.id === playerId);
    if (!player) return;

    this.activeEffects.set(playerId, {
      type: effectType,
      endTime: Date.now() + duration,
      data
    });

    // 通知玩家
    this.room.io.to(playerId).emit('effectApplied', {
      effect: effectType,
      duration,
      data
    });

    // 定时清除效果
    setTimeout(() => {
      this.activeEffects.delete(playerId);
      this.room.io.to(playerId).emit('effectEnded', { effect: effectType });
    }, duration);
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
      team: player.team,
      x: pos.x,
      y: pos.y
    });
  }

  /**
   * 结束当前回合
   */
  endRound() {
    if (this.isEnded) return;

    if (this.gameTimer) {
      clearTimeout(this.gameTimer);
    }
    if (this.spawnTimer) {
      clearTimeout(this.spawnTimer);
    }

    const { settings } = this.room;
    const totalRounds = settings.totalRounds || 1;

    // 广播回合结束
    this.room.io.to(this.room.code).emit('roundEnded', {
      round: this.currentRound,
      totalRounds,
      teamScores: this.teamScores,
      scores: this.room.players.map(p => ({
        id: p.id,
        name: p.name,
        team: p.team,
        score: p.score,
        grabCount: p.grabCount || 0,
        bombCount: p.bombCount || 0,
        maxCombo: this.comboMap.get(p.id) || 0
      }))
    });

    // 检查是否还有下一回合
    if (this.currentRound < totalRounds) {
      this.currentRound++;
      // 3秒后开始下一回合
      setTimeout(() => {
        this.startNextRound();
      }, 3000);
    } else {
      this.endGame();
    }
  }

  /**
   * 开始下一回合
   */
  startNextRound() {
    // 重置状态
    this.packets = [];
    this.activePackets.clear();
    this.grabCount = 0;
    this.packetIndex = 0;
    this.teamPacketCount = { red: 0, blue: 0 };
    this.doubleActive = false;
    this.doubleCount = 0;

    // 重置玩家回合数据
    this.room.players.forEach(p => {
      p.grabCount = 0;
      p.bombCount = 0;
    });

    // 重新生成红包
    this.amounts = generateAmounts(
      this.room.settings.amountType,
      this.room.settings.totalAmount,
      this.room.settings.packetCount,
      this.room.settings.amountConfig
    );

    this.bombs = generateBombs(
      this.room.settings.advanced?.bombRate || 0,
      this.room.settings.packetCount,
      this.room.settings.mechanics?.allowNegative
    );

    // 广播下一回合开始
    this.room.io.to(this.room.code).emit('nextRound', {
      round: this.currentRound,
      totalRounds: this.room.settings.totalRounds || 1
    });

    // 开始生成红包
    this.spawnNextPacket();

    // 启动游戏计时器
    this.gameTimer = setTimeout(() => {
      this.endRound();
    }, this.room.settings.duration * 1000);

    console.log(`[团队战] 房间 ${this.room.code} 第${this.currentRound}局开始`);
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
    
    // 确定获胜队伍
    const winningTeam = this.teamScores.red > this.teamScores.blue ? 'red' : 
                       this.teamScores.blue > this.teamScores.red ? 'blue' : 'tie';

    // 确定MVP
    const mvp = _.maxBy(this.room.players, 'score');

    this.room.io.to(this.room.code).emit('gameEnded', {
      winner: winningTeam,
      mvp: mvp ? {
        id: mvp.id,
        name: mvp.name,
        team: mvp.team,
        score: mvp.score
      } : null,
      teamScores: this.teamScores,
      finalScores: this.room.players.map(p => ({
        id: p.id,
        name: p.name,
        team: p.team,
        role: p.role,
        score: p.score,
        grabCount: p.grabCount || 0,
        bombCount: p.bombCount || 0,
        maxCombo: this.comboMap.get(p.id) || 0
      })),
      stats
    });

    this.room.players.forEach(p => clearClickHistory(p.id));

    console.log(`[团队战] 房间 ${this.room.code} 游戏结束，获胜队伍: ${winningTeam}`);
  }

  /**
   * 计算统计
   */
  calculateStats() {
    const allGrabs = this.grabCount;
    const bombGrabs = this.packets.filter(p => p.isBomb && p.grabbedBy).length;
    const missedPackets = this.packets.filter(p => !p.grabbedBy).length;

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
      teamScores: this.teamScores,
      duration: this.room.settings.duration,
      totalRounds: this.currentRound
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

module.exports = TeamMode;
