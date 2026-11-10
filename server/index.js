// Execução local: `npm start` → http://localhost:3000
// Em produção o site roda na Vercel (api/index.js). Para testar envios por QR Code localmente,
// rode também o motor: `npm run engine` (o mesmo que o app do PC usa).
import { migrate } from './db.js';
import app from './app.js';

const PORT = process.env.PORT || 3000;
await migrate();
app.listen(PORT, () => console.log(`Domma Connect Lead rodando em http://localhost:${PORT}`));
