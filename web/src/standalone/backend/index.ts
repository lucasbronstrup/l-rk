/**
 * Backend simulado da edição web do Lärk: implementa no navegador a mesma API HTTP do servidor Node.
 */
import { warmUpEngines } from './brain';
import { route, type ApiRequest } from './router';
import { startScheduler } from './scheduler';

export { bus } from './bus';
export { engineState, onEngineChange, type EngineState } from './brain';
export type { ApiRequest } from './router';

export function handleApi(req: ApiRequest): Promise<Response> {
  return route(req);
}

let started = false;

/** Liga o agendador de lembretes/cobranças e começa a resolver os motores de IA. */
export function startBackend(): void {
  if (started) return;
  started = true;
  warmUpEngines();
  startScheduler();
}
