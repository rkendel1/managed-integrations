/** Small shadcn/ui-style primitives (copied pattern: cva + tailwind-merge), no external design system. */
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, TdHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400',
  {
    variants: {
      variant: {
        default: 'bg-slate-900 text-white hover:bg-slate-800',
        outline: 'border border-slate-300 bg-white hover:bg-slate-100',
        destructive: 'bg-red-600 text-white hover:bg-red-700',
        ghost: 'hover:bg-slate-100',
      },
      size: { default: 'h-9 px-4', sm: 'h-8 px-3 text-xs' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-lg border border-slate-200 bg-white shadow-sm', className)} {...props} />
  );
}
export function CardHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description ? <p className="text-xs text-slate-500">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}
export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-4', className)} {...props} />;
}

const badgeVariants = cva('inline-flex items-center rounded px-2 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-slate-100 text-slate-700',
      good: 'bg-emerald-100 text-emerald-800',
      warn: 'bg-amber-100 text-amber-800',
      bad: 'bg-red-100 text-red-800',
      info: 'bg-sky-100 text-sky-800',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

const TONES: Record<string, VariantProps<typeof badgeVariants>['tone']> = {
  healthy: 'good',
  active: 'good',
  verified: 'good',
  authorized: 'good',
  succeeded: 'good',
  delivered: 'good',
  consistent: 'good',
  resolved: 'good',
  passed: 'good',
  released: 'good',
  validated: 'good',
  candidate_submitted: 'good',
  degraded: 'warn',
  paused: 'warn',
  partial: 'warn',
  pending: 'warn',
  skipped: 'neutral',
  recoverable: 'warn',
  recovery: 'info',
  verification: 'info',
  investigating: 'info',
  canary: 'info',
  approved: 'info',
  validating: 'info',
  submitted: 'info',
  running: 'info',
  interrupted: 'warn',
  discrepancies: 'warn',
  recovered: 'good',
  completed: 'good',
  missing_delivery: 'bad',
  failed_delivery: 'bad',
  pending_delivery: 'warn',
  ambiguous: 'warn',
  destination_exists_untracked: 'warn',
  undetermined: 'warn',
  unverified: 'bad',
  requested: 'info',
  executing: 'info',
  excluded: 'neutral',
  medium: 'warn',
  failing: 'bad',
  failed: 'bad',
  error: 'bad',
  revoked: 'bad',
  rejected: 'bad',
  requires_action: 'bad',
  rolled_back: 'bad',
  validation_failed: 'bad',
  no_candidate: 'bad',
  high: 'bad',
  critical: 'bad',
  unknown: 'neutral',
  disconnected: 'neutral',
};
export function StatusBadge({ value }: { value: string | null | undefined }) {
  const v = value ?? 'unknown';
  return (
    <span data-status={v} className={badgeVariants({ tone: TONES[v] ?? 'neutral' })}>
      {v.replace(/_/g, ' ')}
    </span>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}
export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3 py-2 align-top', className)} {...props} />;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>
      {children}
    </label>
  );
}
export const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400';

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}
export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-500">{children}</p>;
}
