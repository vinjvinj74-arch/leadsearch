import { httpServerHandler } from 'cloudflare:node';
import { DurableObject } from 'cloudflare:workers';

// Mantido apenas para satisfazer a dependência de Durable Object da versão
// anterior do Worker (que rodava o Express em container). Não é utilizado.
export class RadarContainer extends DurableObject {}

// O Worker roda o Express diretamente (sem containers). As variáveis e secrets
// configurados no Worker já são injetados em process.env pelo nodejs_compat.
// O runtime do Workers não conclui o TLS com o pooler do Supabase; a conexão
// interna com o pooler é feita sem SSL (o pooler aceita nessa porta).
process.env.PGSSL ??= 'false';
process.env.PG_POOL_MAX ??= '3';

// Importação dinâmica: o módulo de configuração lê process.env no carregamento,
// então ele precisa ser avaliado depois dos ajustes acima.
const { createApp } = await import('../src/app.js');

const app = createApp({ serveStatic: false });
app.listen(3000);

export default httpServerHandler({ port: 3000 });
