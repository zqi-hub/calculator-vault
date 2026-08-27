/* calculator.js — 计算器外壳 + 密码解锁
   算术核心：使用 BigInt 有理数 (digits × 10^-scale) 进行无浮点误差运算，
   避免 IEEE 754 double 在大整数乘法 / 末尾噪声处给出 "0.00006" 这种伪结果。 */
(() => {
  const exprEl = document.getElementById('calc-expr');
  const historyEl = document.getElementById('calc-history');
  let expr = '';          // 当前输入表达式
  let justEvaluated = false;

  const OPS = ['+', '−', '×', '÷'];

  function render() {
    exprEl.textContent = expr || '0';
    // 显示区域自适应缩小字号
    exprEl.style.fontSize = expr.length > 12 ? '36px' : expr.length > 8 ? '48px' : '64px';
  }

  function lastNumberRange() {
    const m = expr.match(/[\d.]+%?$/);
    return m ? m[0] : '';
  }

  function press(key) {
    if (key === 'AC') { expr = ''; historyEl.textContent = ''; justEvaluated = false; render(); return; }
    if (key === 'back') { expr = expr.slice(0, -1); justEvaluated = false; render(); return; }

    if (key === '=') { onEquals(); return; }

    if (justEvaluated && !OPS.includes(key)) { expr = ''; historyEl.textContent = ''; }
    justEvaluated = false;

    if (/\d/.test(key)) {
      expr += key;
    } else if (key === '.') {
      const last = lastNumberRange();
      if (!last.includes('.')) expr += (last === '' ? '0.' : '.');
    } else if (OPS.includes(key)) {
      if (expr === '' && key !== '−') return;
      if (OPS.includes(expr.slice(-1))) expr = expr.slice(0, -1) + key;
      else expr += key;
    } else if (key === '%') {
      const last = lastNumberRange();
      if (last && !last.endsWith('%')) expr += '%';
    } else if (key === '±') {
      const last = lastNumberRange();
      if (last) {
        const head = expr.slice(0, expr.length - last.length);
        if (last.startsWith('-')) expr = head + last.slice(1);
        else expr = head + '-' + last;
      }
    }
    render();
  }

  /* ---------- BigInt 精确小数：有符号大整数 + scale，值 = big × 10^(-scale) ---------- */
  class Dec {
    constructor(big, scale) { this.big = big; this.scale = scale; }

    static parse(s) {
      let neg = s.startsWith('-');
      if (neg) s = s.slice(1);
      const dot = s.indexOf('.');
      let digits, scale;
      if (dot === -1) {
        digits = (s || '0').replace(/^0+(?=\d)/, '') || '0';
        scale = 0;
      } else {
        const ip = (s.slice(0, dot) || '0').replace(/^0+(?=\d)/, '') || '0';
        const fp = s.slice(dot + 1);
        digits = (ip + fp).replace(/^0+(?=\d)/, '') || '0';
        scale = fp.length;
      }
      return new Dec(BigInt((neg ? '-' : '') + digits), scale);
    }

    add(o) {
      const s = Math.max(this.scale, o.scale);
      const a = this.big * (10n ** BigInt(s - this.scale));
      const b = o.big * (10n ** BigInt(s - o.scale));
      return new Dec(a + b, s);
    }
    sub(o) {
      const s = Math.max(this.scale, o.scale);
      const a = this.big * (10n ** BigInt(s - this.scale));
      const b = o.big * (10n ** BigInt(s - o.scale));
      return new Dec(a - b, s);
    }
    mul(o) {
      return new Dec(this.big * o.big, this.scale + o.scale);
    }
    div(o) {
      if (o.big === 0n) throw new Error('divide by zero');
      if (this.big === 0n) return new Dec(0n, 0);
      // 在内部保留 20 位有效小数，用于显示精度
      const S = 20;
      const E = o.scale - this.scale + S;
      const safeE = Math.max(E, 0);
      const numer = this.big * (10n ** BigInt(safeE));
      const q = numer / o.big;
      const r = numer % o.big;
      // 四舍五入：余数 * 2 ≥ 除数时进位
      const rounded = (r * 2n >= o.big) ? q + 1n : q;
      return new Dec(rounded, S);
    }
    // 百分号：相当于 ÷100（小数位 +2）
    percent() { return new Dec(this.big, this.scale + 2); }

    toString() {
      if (this.big === 0n) return '0';
      const neg = this.big < 0n;
      const abs = neg ? -this.big : this.big;
      let s = abs.toString();
      // 把小数位用前导零补齐
      while (s.length <= this.scale) s = '0' + s;
      if (this.scale === 0) return (neg ? '-' : '') + s;
      const ip = s.slice(0, s.length - this.scale).replace(/^0+(\d)/, '$1') || '0';
      let fp = s.slice(s.length - this.scale).replace(/0+$/, '');
      return (neg ? '-' : '') + ip + (fp ? '.' + fp : '');
    }
  }

  /* ---------- 带优先级的手写求值器，避免 eval；token 形如 [Dec, op, Dec, op, Dec] ---------- */
  function evaluate(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/[\d.]/.test(ch) || (ch === '−' && (tokens.length === 0 || OPS.includes(tokens[tokens.length - 1])))) {
        let numStr = ch === '−' ? '-' : '';
        if (ch === '−') i++;
        while (i < src.length && /[\d.]/.test(src[i])) numStr += src[i++];
        let isPct = src[i] === '%';
        if (isPct) i++;
        if (numStr === '' || numStr === '-') throw new Error('bad number');
        let val = Dec.parse(numStr);
        if (isPct) val = val.percent();
        tokens.push(val);
      } else if (OPS.includes(ch)) {
        tokens.push(ch); i++;
      } else {
        throw new Error('bad char');
      }
    }
    if (tokens.length === 0) throw new Error('empty');

    // 先乘除
    const pass1 = [tokens[0]];
    for (let k = 1; k < tokens.length; k += 2) {
      const op = tokens[k], rhs = tokens[k + 1];
      if (rhs === undefined) throw new Error('dangling op');
      if (op === '×' || op === '÷') {
        const lhs = pass1.pop();
        pass1.push(op === '×' ? lhs.mul(rhs) : lhs.div(rhs));
      } else {
        pass1.push(op, rhs);
      }
    }
    // 再加减
    let result = pass1[0];
    for (let k = 1; k < pass1.length; k += 2) {
      const op = pass1[k], rhs = pass1[k + 1];
      result = op === '+' ? result.add(rhs) : result.sub(rhs);
    }
    return result.toString();
  }

  async function onEquals() {
    // 纯数字 + "=" → 先尝试密码匹配
    if (/^\d{4,12}$/.test(expr)) {
      if (await PwdStore.verify(expr)) {
        expr = '';
        render();
        Vault.unlock();
        return;
      }
    }
    if (expr === '' || OPS.includes(expr.slice(-1))) return;
    try {
      const result = evaluate(expr);
      historyEl.textContent = expr + ' =';
      expr = result;
      justEvaluated = true;
    } catch (e) {
      historyEl.textContent = '';
      expr = '';
      exprEl.textContent = '错误';
      justEvaluated = true;
      return;
    }
    render();
  }

  document.querySelectorAll('#screen-calc .key').forEach(btn => {
    btn.addEventListener('click', () => press(btn.dataset.key));
  });

  // 物理键盘支持（桌面调试用）
  document.addEventListener('keydown', (e) => {
    if (document.getElementById('screen-calc').classList.contains('hidden')) return;
    const map = { 'Enter': '=', '=': '=', 'Backspace': 'back', 'Escape': 'AC',
                  '+': '+', '-': '−', '*': '×', '/': '÷', '%': '%', '.': '.' };
    if (/\d/.test(e.key)) press(e.key);
    else if (map[e.key] !== undefined) { e.preventDefault(); press(map[e.key]); }
  });

  render();
})();
