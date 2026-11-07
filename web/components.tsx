import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { errorText } from './api';
export const OnlineContext = createContext(true);

export function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    backlog: (
      <>
        <path d="M8 6h13M8 12h13M8 18h13" />
        <path d="M3 6h.1M3 12h.1M3 18h.1" />
      </>
    ),
    board: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16M15 4v10" />
      </>
    ),
    reviews: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <path d="M8 7h8M8 11h8M8 15h5" />
      </>
    ),
    runs: <path d="m5 3 16 9-16 9z" />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="m9 3-1 3-3 1-2 3 2 2-1 4 3 1 2 4 3-1 3 1 2-4 3-1-1-4 2-2-2-3-3-1-1-3z" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    close: <path d="m5 5 14 14M19 5 5 19" />,
    menu: <path d="M3 5h18M3 12h18M3 19h18" />,
    chevron: <path d="m8 4 8 8-8 8" />,
    back: <path d="m14 4-8 8 8 8M6 12h15" />
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.chevron}
    </svg>
  );
}
export function Status({ value, label }: { value: string; label?: string }) {
  const tone = ['DONE', 'SUCCEEDED', 'PASSED', 'VERIFIED', 'APPROVED', 'PASS'].includes(value)
    ? 'good'
    : ['FAILED', 'UNCERTAIN', 'QA_REJECTED', 'LEAD_REJECTED', 'USER_REJECTED', 'FAIL', 'CHANGES_REQUESTED'].includes(
          value
        )
      ? 'bad'
      : ['LEAD_REVIEW', 'IN_REVIEW', 'USER_ACCEPTANCE'].includes(value)
        ? 'review'
        : ['IN_PROGRESS', 'RUNNING', 'QA_TEST', 'VERIFYING'].includes(value)
          ? 'active'
          : 'neutral';
  return <span className={`status ${tone}`}>{label ?? value.replaceAll('_', ' ').toLowerCase()}</span>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    heading.current?.focus();
    const cancel = (event: Event) => {
      event.preventDefault();
      close.current();
    };
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const controls = [
        ...element.querySelectorAll<HTMLElement>(
          'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]'
        )
      ].filter((control) => control.getClientRects().length && !control.closest('fieldset[disabled]'));
      if (!controls.length) {
        event.preventDefault();
        heading.current?.focus();
        return;
      }
      const first = controls[0];
      const last = controls.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    element.addEventListener('cancel', cancel);
    element.addEventListener('keydown', trap);
    return () => {
      element.removeEventListener('cancel', cancel);
      element.removeEventListener('keydown', trap);
      element.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog ref={dialog} className="modal" aria-labelledby="modal-title">
      <header className="modal-head">
        <div>
          <h2 ref={heading} tabIndex={-1} id="modal-title">
            {title}
          </h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function AsyncForm({
  onSave,
  children,
  onDone,
  className
}: {
  onSave(data: FormData): Promise<unknown>;
  children: ReactNode;
  onDone?(): void;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const key = useRef(crypto.randomUUID());
  const online = useContext(OnlineContext);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !online) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const data = new FormData(event.currentTarget, submitter);
    data.set('idempotencyKey', key.current);
    setBusy(true);
    setError('');
    try {
      await onSave(data);
      key.current = crypto.randomUUID();
      onDone?.();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className={className} aria-busy={busy}>
      <fieldset disabled={busy || !online}>{children}</fieldset>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {busy ? (
        <p className="saving" role="status">
          Saving…
        </p>
      ) : null}
    </form>
  );
}
export function JsonView({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}
