/**
 * 防作弊系统
 * 检测和防止各种作弊行为
 */

const _ = require('lodash');

// 点击频率限制：单秒超过5次视为作弊
const CLICK_RATE_LIMIT = 5;
// 坐标容差：允许10px的误差
const POSITION_TOLERANCE = 10;
// 点击历史记录（用于频率检测）
const clickHistory = new Map();

/**
 * 验证点击是否合法
 * @param {object} player - 玩家对象
 * @param {object} packet - 红包对象
 * @param {object} clickData - 点击数据 {timestamp, pos: {x, y}}
 * @param {object} gameSettings - 游戏设置
 * @returns {object} {valid: boolean, reason?: string}
 */
function validateClick(player, packet, clickData, gameSettings) {
  // 1. 检查红包是否已被抢
  if (packet.grabbedBy) {
    return { valid: false, reason: '红包已被抢' };
  }

  // 2. 时间戳校验：红包出现前点击无效
  if (clickData.timestamp < packet.spawnTime) {
    return { valid: false, reason: '红包尚未出现' };
  }

  // 3. 坐标校验：点击位置必须在红包范围内
  if (!validatePosition(clickData.pos, packet, gameSettings)) {
    return { valid: false, reason: '点击位置无效' };
  }

  // 4. 点击频率检测
  if (checkClickFrequency(player.id, clickData.timestamp)) {
    return { valid: false, reason: '点击频率异常' };
  }

  // 5. 技能CD校验（团队战模式）
  if (player.lastSkillTime && player.role) {
    const skillCD = getSkillCooldown(player.role, gameSettings);
    const elapsed = Date.now() - player.lastSkillTime;
    if (elapsed < skillCD) {
      return { valid: false, reason: '技能冷却中' };
    }
  }

  return { valid: true };
}

/**
 * 验证点击位置是否在红包范围内
 */
function validatePosition(pos, packet, gameSettings) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
    return false;
  }

  // 红包尺寸（与前端保持一致）
  const packetWidth = 80;
  const packetHeight = 100;

  // 计算红包边界（考虑容差）
  const left = packet.x - POSITION_TOLERANCE;
  const right = packet.x + packetWidth + POSITION_TOLERANCE;
  const top = packet.y - POSITION_TOLERANCE;
  const bottom = packet.y + packetHeight + POSITION_TOLERANCE;

  return pos.x >= left && pos.x <= right && pos.y >= top && pos.y <= bottom;
}

/**
 * 检测点击频率是否异常
 */
function checkClickFrequency(playerId, timestamp) {
  if (!clickHistory.has(playerId)) {
    clickHistory.set(playerId, []);
  }

  const history = clickHistory.get(playerId);
  const now = timestamp || Date.now();
  const oneSecondAgo = now - 1000;

  // 清理1秒前的记录
  const recentClicks = history.filter(t => t > oneSecondAgo);
  recentClicks.push(now);
  clickHistory.set(playerId, recentClicks);

  // 检测是否超过频率限制
  return recentClicks.length > CLICK_RATE_LIMIT;
}

/**
 * 获取技能冷却时间
 */
function getSkillCooldown(role, gameSettings) {
  const baseCD = {
    'striker': 15000,    // 突击手 15秒
    'disruptor': 20000,  // 干扰者 20秒
    'scout': 25000,      // 侦察兵 25秒
    'guardian': 0,       // 守护者 被动技能
    'lucky': 30000       // 幸运星 30秒
  };

  const multiplier = gameSettings?.advanced?.skillCDMultiplier || 1;
  return (baseCD[role] || 0) * multiplier;
}

/**
 * 验证固定金额模式的数据
 * @param {number} packetIndex - 客户端传来的红包索引
 * @param {object} packet - 服务器存储的红包对象
 * @param {string} amountType - 金额类型
 */
function validateFixedAmount(packetIndex, packet, amountType) {
  if (amountType !== 'fixed') {
    return { valid: true };
  }

  // 固定金额模式下，客户端只传索引，不传金额
  // 服务器根据索引获取金额
  if (typeof packetIndex !== 'number' || packetIndex < 0) {
    return { valid: false, reason: '无效的红包索引' };
  }

  return { valid: true };
}

/**
 * 验证游戏设置是否合法
 * @param {object} settings - 游戏设置
 */
function validateSettings(settings) {
  const errors = [];

  // 基础设置验证
  if (settings.totalAmount < 1 || settings.totalAmount > 2000) {
    errors.push('总金额必须在1-2000元之间');
  }

  if (settings.packetCount < 2 || settings.packetCount > 50) {
    errors.push('红包数量必须在2-50个之间');
  }

  if (settings.duration < 10 || settings.duration > 120) {
    errors.push('游戏时长必须在10-120秒之间');
  }

  // 验证金额配置
  if (settings.amountType === 'fixed' && settings.amountConfig?.amounts) {
    const sum = settings.amountConfig.amounts.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - settings.totalAmount) > 0.01) {
      errors.push('固定金额总和与设定总额不符');
    }
    if (settings.amountConfig.amounts.length !== settings.packetCount) {
      errors.push('固定金额数量与红包数量不符');
    }
  }

  // 验证区间设置
  if (settings.amountType === 'range') {
    const min = settings.amountConfig?.min || 0.01;
    const max = settings.amountConfig?.max || settings.totalAmount;
    if (min >= max) {
      errors.push('最小金额必须小于最大金额');
    }
    if (min * settings.packetCount > settings.totalAmount) {
      errors.push('最小金额设置过高，无法分配');
    }
  }

  // 高级参数验证
  if (settings.advanced) {
    if (settings.advanced.bombRate < 0 || settings.advanced.bombRate > 50) {
      errors.push('炸弹概率必须在0-50%之间');
    }
    if (settings.advanced.spawnSpeed < 0.5 || settings.advanced.spawnSpeed > 3) {
      errors.push('红包出现速度必须在0.5x-3x之间');
    }
    if (settings.advanced.skillCDMultiplier < 0.5 || settings.advanced.skillCDMultiplier > 2) {
      errors.push('技能冷却系数必须在0.5x-2x之间');
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 清理玩家的点击历史
 */
function clearClickHistory(playerId) {
  clickHistory.delete(playerId);
}

/**
 * 获取作弊统计（用于调试）
 */
function getCheatStats() {
  const stats = {};
  clickHistory.forEach((history, playerId) => {
    stats[playerId] = history.length;
  });
  return stats;
}

module.exports = {
  validateClick,
  validatePosition,
  checkClickFrequency,
  getSkillCooldown,
  validateFixedAmount,
  validateSettings,
  clearClickHistory,
  getCheatStats
};
