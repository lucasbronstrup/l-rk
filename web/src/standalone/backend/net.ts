/**
 * fetch original do navegador, capturado antes de install.ts interceptar /api.
 * (Os módulos do backend são avaliados antes do corpo de install.ts.)
 */
export const nativeFetch: typeof fetch = window.fetch.bind(window);
