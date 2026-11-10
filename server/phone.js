// Normalização de telefones (foco no Brasil, aceita internacionais com +DDI)
const DDDS = new Set([
  11,12,13,14,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,41,42,43,44,45,46,47,48,49,
  51,53,54,55,61,62,63,64,65,66,67,68,69,71,73,74,75,77,79,81,82,83,84,85,86,87,88,89,
  91,92,93,94,95,96,97,98,99,
]);

/**
 * @returns {{ok:true, phone:string} | {ok:false, error:string}}
 */
export function normalizePhone(raw, { defaultDDD } = {}) {
  if (raw === null || raw === undefined) return { ok: false, error: 'Telefone vazio' };
  let s = String(raw).trim();
  if (!s) return { ok: false, error: 'Telefone vazio' };
  // Excel às vezes devolve número em notação científica
  if (/e\+/i.test(s) && !isNaN(Number(s))) s = Number(s).toFixed(0);
  const international = s.startsWith('+') || s.startsWith('00');
  let d = s.replace(/\D/g, '');
  if (s.startsWith('00')) d = d.slice(2);

  if (international && !d.startsWith('55')) {
    if (d.length >= 8 && d.length <= 15) return { ok: true, phone: d };
    return { ok: false, error: 'Número internacional inválido' };
  }

  d = d.replace(/^0+/, ''); // 031..., 0xx31...
  // operadora de longa distância: 0 + 2 dígitos operadora + DDD (ex.: 0 21 31 9xxxx)
  if (d.length === 13 && !d.startsWith('55')) d = d.slice(2);

  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    // ok
  } else if (d.length === 10 || d.length === 11) {
    d = '55' + d;
  } else if ((d.length === 8 || d.length === 9) && defaultDDD) {
    d = '55' + String(defaultDDD) + d;
  } else if (d.length === 8 || d.length === 9) {
    return { ok: false, error: 'Sem DDD' };
  } else {
    return { ok: false, error: 'Quantidade de dígitos inválida' };
  }

  const ddd = Number(d.slice(2, 4));
  if (!DDDS.has(ddd)) return { ok: false, error: `DDD ${ddd} inexistente` };
  const local = d.slice(4);
  if (local.length === 9 && local[0] !== '9') return { ok: false, error: 'Celular deve começar com 9' };
  return { ok: true, phone: d };
}

export function formatPhone(p) {
  if (!p) return '';
  if (p.startsWith('55') && p.length === 13) return `(${p.slice(2, 4)}) ${p.slice(4, 9)}-${p.slice(9)}`;
  if (p.startsWith('55') && p.length === 12) return `(${p.slice(2, 4)}) ${p.slice(4, 8)}-${p.slice(8)}`;
  return '+' + p;
}
