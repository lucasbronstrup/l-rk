import { Children, isValidElement, memo, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';
import { copyText, nodeText } from './format';

/** Botão "copiar" dos blocos de código. */
export function CopyButton({ text, label = 'Copiar código', className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  return (
    <button
      type="button"
      aria-label={copied ? 'Copiado' : label}
      title={label}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1600);
        }
      }}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 border border-transparent px-1.5 font-mono text-[10px] tracking-[0.18em] transition-colors',
        copied ? 'text-ok' : 'text-muted hover:border-line hover:text-ink',
        className,
      )}
    >
      {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      <span>{copied ? 'COPIADO' : 'COPIAR'}</span>
    </button>
  );
}

function CodeBlock({ node: _node, children, ...rest }: ComponentPropsWithoutRef<'pre'> & ExtraProps) {
  const child = Children.toArray(children)[0];
  let lang = '';
  let code = '';
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    lang = /language-([\w+#.-]+)/.exec(child.props.className ?? '')?.[1] ?? '';
    code = nodeText(child.props.children);
  } else {
    code = nodeText(children);
  }
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="truncate">{`// ${lang || 'código'}`}</span>
        <CopyButton text={code.replace(/\n$/, '')} />
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  );
}

function Anchor({ node: _node, href, children, ...rest }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  const external = typeof href === 'string' && /^https?:\/\//i.test(href);
  return (
    <a href={href} {...rest} {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
      {children}
    </a>
  );
}

function Image({ node: _node, alt, ...rest }: ComponentPropsWithoutRef<'img'> & ExtraProps) {
  return <img alt={alt ?? ''} loading="lazy" decoding="async" {...rest} />;
}

const components: Components = { pre: CodeBlock, a: Anchor, img: Image };
const plugins = [remarkGfm];

/** Markdown do chat (GFM) com estilos .prose-lark e blocos de código copiáveis. */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('prose-lark min-w-0', className)}>
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** Variante leve para o raciocínio (sem cabeçalho de código). */
export const ThoughtMarkdown = memo(function ThoughtMarkdown({ text }: { text: string }) {
  return (
    <div className="lark-thought">
      <ReactMarkdown remarkPlugins={plugins}>{text}</ReactMarkdown>
    </div>
  );
});
