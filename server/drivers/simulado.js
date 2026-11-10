// Conexão de teste: simula envios sem tocar no WhatsApp real.
// A entrega e a leitura são simuladas depois, em advanceSimulated() (dispatch.js).
export class SimuladoDriver {
  constructor(conn, hooks) {
    this.conn = conn; this.hooks = hooks;
    this.status = 'conectado'; this.qr = null; this.phone = '5531999990000';
  }
  async start() { await this.hooks.onState(this.conn.id, { status: 'conectado', phone: this.phone }); }
  async stop() {}
  async logout() {}
  async send({ phone }) {
    await new Promise(r => setTimeout(r, 150 + Math.random() * 400));
    const r = Math.random();
    if (phone.endsWith('0000')) { const e = new Error('Número não tem WhatsApp'); e.code = 'NO_WHATSAPP'; throw e; }
    if (r < 0.04) { const e = new Error('Número não tem WhatsApp'); e.code = 'NO_WHATSAPP'; throw e; }
    if (r < 0.06) { const e = new Error('Falha temporária simulada'); e.code = 'TEMP'; throw e; }
    return { id: 'SIM-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) };
  }
}
