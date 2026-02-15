/**
 * 红包金额生成工具
 * 支持四种金额类型：random, fixed, range, equal
 */

const _ = require('lodash');

/**
 * 生成红包金额列表
 * @param {string} type - 金额类型: random, fixed, range, equal
 * @param {number} total - 总金额
 * @param {number} count - 红包数量
 * @param {object} config - 配置参数
 * @returns {number[]} 金额列表
 */
function generateAmounts(type, total, count, config = {}) {
  switch (type) {
    case 'random':
      return generateRandomAmounts(total, count);
    case 'fixed':
      return validateAndUseFixed(config.amounts, total, count);
    case 'range':
      return generateRangeAmounts(total, count, config.min, config.max);
    case 'equal':
      return generateEqualAmounts(total, count);
    default:
      return generateRandomAmounts(total, count);
  }
}

/**
 * 二倍均值法随机分配（传统微信红包算法）
 * 保证随机性的同时，避免极端值
 */
function generateRandomAmounts(total, count) {
  if (count <= 0) return [];
  if (count === 1) return [Math.round(total * 100) / 100];

  const amounts = [];
  let remainingTotal = total;
  let remainingCount = count;

  for (let i = 0; i < count - 1; i++) {
    // 二倍均值法：剩余平均值 * 2 范围内的随机数
    const avg = remainingTotal / remainingCount;
    const max = Math.min(avg * 2, remainingTotal - 0.01 * (remainingCount - 1));
    const min = 0.01;
    
    const amount = Math.floor((Math.random() * (max - min) + min) * 100) / 100;
    amounts.push(amount);
    
    remainingTotal -= amount;
    remainingCount--;
  }

  // 最后一个红包获得剩余金额
  amounts.push(Math.round(remainingTotal * 100) / 100);

  // 打乱顺序增加随机性
  return _.shuffle(amounts);
}

/**
 * 使用房主预设的固定金额
 */
function validateAndUseFixed(amounts, total, count) {
  if (!amounts || !Array.isArray(amounts) || amounts.length !== count) {
    console.warn('固定金额配置无效，使用随机分配');
    return generateRandomAmounts(total, count);
  }

  const sum = amounts.reduce((a, b) => a + b, 0);
  const roundedSum = Math.round(sum * 100) / 100;
  const roundedTotal = Math.round(total * 100) / 100;

  if (Math.abs(roundedSum - roundedTotal) > 0.01) {
    console.warn(`固定金额总和(${roundedSum})与设定总额(${roundedTotal})不符，使用随机分配`);
    return generateRandomAmounts(total, count);
  }

  return amounts.map(a => Math.round(a * 100) / 100);
}

/**
 * 区间内均匀随机分配
 */
function generateRangeAmounts(total, count, min = 0.01, max = total) {
  if (count <= 0) return [];
  
  const minAmount = Math.max(0.01, min);
  const maxAmount = Math.min(max, total - 0.01 * (count - 1));

  if (minAmount * count > total) {
    console.warn('最小金额设置过高，使用随机分配');
    return generateRandomAmounts(total, count);
  }

  const amounts = [];
  let remainingTotal = total;
  let remainingCount = count;

  for (let i = 0; i < count - 1; i++) {
    const availableMax = Math.min(maxAmount, remainingTotal - minAmount * (remainingCount - 1));
    const amount = Math.floor((Math.random() * (availableMax - minAmount) + minAmount) * 100) / 100;
    amounts.push(amount);
    
    remainingTotal -= amount;
    remainingCount--;
  }

  amounts.push(Math.round(remainingTotal * 100) / 100);
  return _.shuffle(amounts);
}

/**
 * 平均分配，余数给最后一个
 */
function generateEqualAmounts(total, count) {
  if (count <= 0) return [];
  
  const base = Math.floor((total / count) * 100) / 100;
  const result = Array(count - 1).fill(base);
  const lastAmount = Math.round((total - base * (count - 1)) * 100) / 100;
  result.push(lastAmount);
  
  // 打乱顺序
  return _.shuffle(result);
}

/**
 * 生成炸弹红包
 * @param {number} bombRate - 炸弹概率 0-50
 * @param {number} count - 红包总数
 * @param {boolean} allowNegative - 是否允许负分
 * @returns {boolean[]} 是否是炸弹的标记数组
 */
function generateBombs(bombRate, count, allowNegative = false) {
  if (!allowNegative || bombRate <= 0) {
    return Array(count).fill(false);
  }

  const rate = Math.min(50, Math.max(0, bombRate)) / 100;
  const bombCount = Math.floor(count * rate);
  
  const bombs = Array(count).fill(false);
  const indices = _.shuffle(_.range(count));
  
  for (let i = 0; i < bombCount; i++) {
    bombs[indices[i]] = true;
  }

  return bombs;
}

/**
 * 计算炸弹扣除金额
 * @param {number} baseAmount - 基础金额
 * @param {boolean} allowNegative - 是否允许负分
 * @param {number} currentScore - 当前分数
 */
function calculateBombPenalty(baseAmount, allowNegative, currentScore) {
  const penalty = baseAmount * 0.5; // 炸弹扣除50%
  
  if (!allowNegative) {
    // 不允许负分，最多扣到0
    return Math.min(penalty, currentScore);
  }
  
  return penalty;
}

module.exports = {
  generateAmounts,
  generateRandomAmounts,
  generateRangeAmounts,
  generateEqualAmounts,
  generateBombs,
  calculateBombPenalty
};
