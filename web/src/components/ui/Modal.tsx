import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { HudPanel } from './HudPanel';
import { IconButton } from './IconButton';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  code?: string;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ open, onClose, title, code, className, children, footer }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={onClose} />
      <HudPanel
        title={title}
        code={code}
        className={cn('relative z-10 max-h-[90dvh] w-full max-w-lg bg-abyss/95 shadow-glow-lg', className)}
        bodyClassName="overflow-y-auto"
        actions={
          <IconButton label="Fechar" size="sm" onClick={onClose}>
            <X size={14} />
          </IconButton>
        }
      >
        <div className="p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </HudPanel>
    </div>,
    document.body,
  );
}
