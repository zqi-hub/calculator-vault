/* calculator.js — 计算器外壳 + 密码解锁 */
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

  /* 带优先级的手写求值器，避免 eval */
  function evaluate(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/[\d.]/.test(ch) || (ch === '-' && (tokens.length === 0 || OPS.includes(tokens[tokens.length - 1])))) {
        let num = ch === '-' ? '-' : '';
        if (ch === '-') i++;
        while (i < src.length && /[\d.]/.test(src[i])) num += src[i++];
        let val = parseFloat(num);
        if (src[i] === '%') { val /= 100; i++; }
        if (isNaN(val)) throw new Error('bad number');
        tokens.push(String(val));
      } else if (OPS.includes(ch)) {
        tokens.push(ch); i++;
      } else { throw new Error('bad char'); }
    }
    if (tokens.length === 0) throw new Error('empty');

    // 先乘除
    const pass1 = [tokens[0]];
    for (let k = 1; k < tokens.length; k += 2) {
      const op = tokens[k], rhs = tokens[k + 1];
      if (rhs === undefined) throw new Error('dangling op');
      if (op === '×' || op === '÷') {
        const lhs = parseFloat(pass1.pop());
        const r = op === '×' ? lhs * parseFloat(rhs) : lhs / parseFloat(rhs);
        pass1.push(String(r));
      } else {
        pass1.push(op, rhs);
      }
    }
    // 再加减
    let result = parseFloat(pass1[0]);
    for (let k = 1; k < pass1.length; k += 2) {
      const op = pass1[k], rhs = parseFloat(pass1[k + 1]);
      result = op === '+' ? result + rhs : result - rhs;
    }
    if (!isFinite(result)) throw new Error('overflow');
    // 去掉浮点噪声
    return String(Math.round(result * 1e10) / 1e10);
  }

  async function onEquals() {
    // 纯数字 + “=” → 先尝试密码匹配
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
