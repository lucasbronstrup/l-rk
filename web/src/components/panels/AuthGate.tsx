import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { motion, useAnimationControls } from 'motion/react';
import { LoaderCircle, Lock, LogIn } from 'lucide-react';
import { LarkLogo, ReactorOrb } from '@/components/hud';
import { Field, HudButton, HudPanel } from '@/components/ui';
import { api, isApiError, errorMessage, UNAUTHORIZED_EVENT } from '@/lib/api';
import { playSfx } from '@/lib/sfx';
import { useData } from '@/store/data';
import { EASE_OUT_EXPO } from './parts';

/** Tempo máximo esperando /auth/status antes de seguir (servidor lento ou fora do ar). */
const STATUS_GRACE_MS = 1500;

function LoginScreen() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shake = useAnimationControls();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(password);
      if (res.authenticated) {
        playSfx('listen');
        useData.getState().setAuth({ required: res.required, authenticated: true });
        return;
      }
      throw new Error('Senha incorreta.');
    } catch (err) {
      const message =
        isApiError(err) && err.status === 401
          ? 'Senha incorreta. A porta continua fechada.'
          : isApiError(err) && err.code === 'network'
            ? 'Sem conexão com o núcleo. Verifique se o servidor do Lärk está rodando.'
            : errorMessage(err);
      setError(message);
      setPassword('');
      playSfx('error');
      void shake.start({ x: [0, -10, 9, -6, 5, -2, 0], transition: { duration: 0.45 } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-dvh items-center justify-center overflow-y-auto px-4 py-8">
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: EASE_OUT_EXPO }}
        className="w-full max-w-sm"
      >
        <div className="flex flex-col items-center text-center">
          <ReactorOrb size={132} variant="compact" label="none" interactive={false} stateOverride={error ? 'alert' : busy ? 'thinking' : 'idle'} />
          <LarkLogo size="lg" className="mt-7" />
          <p className="mt-4 flex items-center gap-2 font-hud text-[12px] font-bold uppercase tracking-[0.42em] text-red-bright text-glow-soft">
            <Lock size={12} aria-hidden /> Acesso restrito
          </p>
        </div>

        <motion.div animate={shake} className="mt-8">
          <HudPanel title="Identificação" code="SEC-00" className="bg-abyss/[0.94] shadow-glow">
            <form onSubmit={submit} className="space-y-4 p-4">
              <p className="text-[13px] leading-relaxed text-muted">Este núcleo responde apenas ao seu dono. Identifique-se para despertá-lo.</p>
              <Field
                label="Senha"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? 'auth-error' : undefined}
              />
              {error && (
                <p id="auth-error" role="alert" className="text-[12.5px] text-red-soft">
                  {error}
                </p>
              )}
              <HudButton
                type="submit"
                variant="primary"
                className="w-full"
                disabled={!password || busy}
                icon={busy ? <LoaderCircle size={14} className="animate-spin" /> : <LogIn size={14} />}
              >
                {busy ? 'Verificando' : 'Entrar'}
              </HudButton>
            </form>
          </HudPanel>
        </motion.div>

        <p className="mt-5 text-center font-mono text-[9.5px] uppercase tracking-[0.3em] text-dim">SYS//LOCK · sessão protegida por senha</p>
      </motion.div>
    </div>
  );
}

/**
 * Portão de acesso: consulta /api/auth/status e, se o servidor exigir senha e não houver sessão,
 * mostra a tela "ACESSO RESTRITO". Qualquer 401 posterior (evento 'lark:unauthorized') fecha o portão.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const required = useData((s) => s.authRequired);
  const authenticated = useData((s) => s.authenticated);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const grace = window.setTimeout(() => !cancelled && setReady(true), STATUS_GRACE_MS);

    api
      .authStatus()
      .then((s) => {
        if (!cancelled) useData.getState().setAuth({ required: s.required, authenticated: s.authenticated });
      })
      .catch(() => {
        // Sem resposta: segue em frente. Se a senha for exigida, o primeiro 401 reabre o portão.
        if (!cancelled && useData.getState().authRequired === null) useData.getState().setAuth({ required: false, authenticated: true });
      })
      .finally(() => {
        window.clearTimeout(grace);
        if (!cancelled) setReady(true);
      });

    const onUnauthorized = () => useData.getState().setAuth({ required: true, authenticated: false });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      cancelled = true;
      window.clearTimeout(grace);
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, []);

  if (!ready && authenticated === null) return null;
  if (required && authenticated === false) return <LoginScreen />;
  return <>{children}</>;
}
