// Conexão de teste: simula envios sem tocar no WhatsApp real.
export class SimuladoDriver {
  constructor(conn, hooks) {
    this.conn = conn; this.hooks = hooks;
    this.status = 'conectado'; this.qr = null; this.phone = '5531999990000';
  }
  async start() { this.hooks.onState(this.conn.id, { status: 'conectado', phone: this.phone }); }
  async stop() {}
  async logout() {}
  async send({ phone }) {
    await new Promise(r => setTimeout(r, 150 + Math.random() * 400));
    const r = Math.random();
    if (phone.endsWith('0000')) { const e = new Error('Número não tem WhatsApp'); e.code = 'NO_WHATSAPP'; throw e; }
    if (r < 0.04) { const e = new Error('Número não tem WhatsApp'); e.code = 'NO_WHATSAPP'; throw e; }
    if (r < 0.06) { const e = new Error('Falha temporária simulada'); e.code = 'TEMP'; throw e; }
    const id = 'SIM-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    // simula entrega e leitura
    setTimeout(() => this.hooks.onStatus(id, 'entregue'), 1500 + Math.random() * 3000);
    if (Math.random() < 0.6) setTimeout(() => this.hooks.onStatus(id, 'lido'), 5000 + Math.random() * 8000);
    return { id };
  }
}
