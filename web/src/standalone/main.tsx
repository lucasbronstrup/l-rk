/**
 * Entrada da edição web standalone do Lärk.
 * 1) './install' troca fetch/EventSource/WebSocket de /api pelo backend local (precisa vir primeiro);
 * 2) '../main' monta a aplicação normal, sem nenhuma alteração;
 * 3) ajustes da edição web (selo, textos, saúde do motor).
 */
import './install';
import '../main';
import { mountWebEdition } from './webEdition';

mountWebEdition();
