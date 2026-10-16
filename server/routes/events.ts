/**
 * Stream global de eventos em tempo real.
 *  GET /events → text/event-stream de LarkEvent (hello ao conectar, ping a cada 20 s).
 */
import { Hono } from 'hono';
import { streamEvents } from '../lib/sse.js';

export const eventRoutes = new Hono();

eventRoutes.get('/events', (c) => streamEvents(c));
