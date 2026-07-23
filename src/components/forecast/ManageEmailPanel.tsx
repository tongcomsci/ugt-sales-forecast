import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bell,
  BellOff,
  Loader2,
  Mail,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  api,
  ApiError,
  type EmployeeContact,
  type ForecastCcRecipient,
} from '../../lib/api';

const DEFAULT_CC_NOTIFY_EMAIL = 'taksaporn@ube.co.th';

function isDefaultCcNotify(email: string) {
  return email.trim().toLowerCase() === DEFAULT_CC_NOTIFY_EMAIL;
}

type ManageEmailPanelProps = {
  readonly open: boolean;
  readonly onClose: () => void;
};

function makeTempId() {
  return globalThis.crypto.randomUUID();
}

function Avatar({ name }: Readonly<{ readonly name: string }>) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase() ?? '')
    .join('') || '?';
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#007ABE] to-[#005a8c] text-[10px] font-bold text-white">
      {initials}
    </div>
  );
}

export function ManageEmailPanel({ open, onClose }: ManageEmailPanelProps) {
  const [ccList, setCcList] = useState<ForecastCcRecipient[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<EmployeeContact[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const ccResponse = await api.forecastEmail.listCcRecipients();
        if (cancelled) return;
        setCcList(ccResponse);
      } catch (error) {
        if (!cancelled) {
          setError(error instanceof ApiError ? error.message : 'Failed to load email settings');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const query = searchQuery.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.employees.search(query);
        if (!cancelled) setSearchResults(response.results);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, searchQuery]);

  const ccEmpCodes = useMemo(() => new Set(ccList.map(item => item.empCode)), [ccList]);

  const handleToggleNotify = useCallback((empCode: string) => {
    setCcList(current =>
      current.map(item =>
        item.empCode === empCode ? { ...item, notifyEnabled: !item.notifyEnabled } : item
      )
    );
  }, []);

  const handleRemove = useCallback((empCode: string) => {
    setCcList(current => current.filter(item => item.empCode !== empCode));
  }, []);

  const handleAdd = useCallback((employee: EmployeeContact) => {
    const email = employee.currentEmail.toLowerCase();
    setCcList(current => {
      if (current.some(item => item.empCode === employee.empCode)) return current;
      return [
        ...current,
        {
          id: makeTempId(),
          empCode: employee.empCode,
          fullNameEng: employee.fullNameEng,
          currentEmail: email,
          notifyEnabled: isDefaultCcNotify(email),
          source: 'manual',
          sortOrder: current.length,
        },
      ];
    });
    setSearchQuery('');
    setSearchResults([]);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = ccList.map((item, index) => ({ ...item, sortOrder: index }));
      const saved = await api.forecastEmail.saveCcRecipients(payload);
      setCcList(saved);
      onClose();
    } catch (error) {
      setError(error instanceof ApiError ? error.message : 'Failed to save email settings');
    } finally {
      setSaving(false);
    }
  }, [ccList, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <motion.button
            type="button"
            aria-label="Close manage email dialog"
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.section
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0, scale: 0.97, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 12 }}
            transition={{ type: 'spring', duration: 0.32, bounce: 0.18 }}
            className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-slate-100 bg-gradient-to-r from-[#007ABE]/[0.06] to-transparent px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#007ABE] text-white shadow-sm">
                  <Mail size={17} strokeWidth={2} />
                </div>
                <div>
                  <h2 className="text-sm font-bold tracking-tight text-slate-900">Manage Email</h2>
                  <p className="text-[11px] text-slate-500">
                    Combined CC list for forecast commits and Diff Plan alerts
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <X size={18} />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-5 overflow-auto px-5 py-4">
              {error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700">
                  {error}
                </div>
              )}

              <section>
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Mail size={13} className="text-slate-400" />
                    <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                      CC recipients
                    </h3>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
                    {ccList.filter(item => item.notifyEnabled).length}/{ccList.length} notify
                  </span>
                </div>
                <p className="mb-2 text-[11px] text-slate-400">
                  Ticked recipients receive forecast commit emails and Diff Plan breach alerts.
                  Default notify is on for Taksaporn Poldongnok only — use the bell to enable others.
                </p>
                <div className="space-y-1.5">
                  {loading && ccList.length === 0 ? (
                    <div className="flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-3 text-xs text-slate-400">
                      <Loader2 size={14} className="animate-spin" /> Loading…
                    </div>
                  ) : ccList.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-400">
                      No CC recipients yet — search and add below.
                    </div>
                  ) : (
                    ccList.map(item => (
                      <div
                        key={item.empCode}
                        className={cn(
                          'flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors',
                          item.notifyEnabled
                            ? 'border-slate-200 bg-white'
                            : 'border-slate-100 bg-slate-50/60'
                        )}
                      >
                        <Avatar name={item.fullNameEng || item.empCode} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-xs font-semibold text-slate-800">
                              {item.fullNameEng || '(No name)'}
                            </p>
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[9px] text-slate-500">
                              {item.empCode}
                            </span>
                            {item.source === 'nylon_default' && (
                              <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[9px] font-semibold text-indigo-500">
                                Nylon
                              </span>
                            )}
                          </div>
                          <p className="truncate text-[11px] text-slate-400">
                            {item.currentEmail || 'No email'}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleToggleNotify(item.empCode)}
                          title={item.notifyEnabled ? 'Disable notifications' : 'Enable notifications'}
                          className={cn(
                            'flex h-7 w-7 items-center justify-center rounded-lg border transition-colors',
                            item.notifyEnabled
                              ? 'border-[#007ABE]/30 bg-[#007ABE]/10 text-[#007ABE]'
                              : 'border-slate-200 bg-white text-slate-300 hover:text-slate-500'
                          )}
                        >
                          {item.notifyEnabled ? <Bell size={13} /> : <BellOff size={13} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemove(item.empCode)}
                          title="Remove from list"
                          className="flex h-7 w-7 items-center justify-center rounded-lg border border-rose-200 bg-white text-rose-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section>
                <div className="mb-2 flex items-center gap-2">
                  <Search size={13} className="text-slate-400" />
                  <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    Add recipient (search employee)
                  </h3>
                </div>
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-300" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={event => setSearchQuery(event.target.value)}
                    placeholder="Type name or employee code (at least 2 characters)"
                    className="h-9 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-xs text-slate-800 outline-none transition-colors focus:border-[#007ABE] focus:ring-1 focus:ring-[#007ABE]/20"
                  />
                  {searching && (
                    <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-slate-300" />
                  )}
                </div>

                {searchQuery.trim().length >= 2 && (
                  <div className="mt-1.5 max-h-52 space-y-1 overflow-auto rounded-xl border border-slate-100 bg-slate-50/60 p-1.5">
                    {!searching && searchResults.length === 0 ? (
                      <p className="px-2 py-3 text-center text-[11px] text-slate-400">No employees found</p>
                    ) : (
                      searchResults.map(employee => {
                        const added = ccEmpCodes.has(employee.empCode);
                        return (
                          <button
                            key={employee.empCode}
                            type="button"
                            disabled={added}
                            onClick={() => handleAdd(employee)}
                            className={cn(
                              'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                              added ? 'cursor-not-allowed opacity-50' : 'hover:bg-white'
                            )}
                          >
                            <Avatar name={employee.fullNameEng || employee.empCode} />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <p className="truncate text-xs font-semibold text-slate-800">
                                  {employee.fullNameEng || '(No name)'}
                                </p>
                                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[9px] text-slate-500">
                                  {employee.empCode}
                                </span>
                              </div>
                              <p className="truncate text-[11px] text-slate-400">
                                {employee.currentEmail || 'No email'}
                              </p>
                            </div>
                            <span
                              className={cn(
                                'flex h-6 w-6 items-center justify-center rounded-md',
                                added ? 'text-emerald-500' : 'text-[#007ABE]'
                              )}
                            >
                              <Plus size={14} />
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                )}
              </section>
            </div>

            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
              <button
                type="button"
                onClick={onClose}
                className="h-9 rounded-lg border border-slate-200 bg-white px-4 text-xs font-bold text-slate-600 transition-colors hover:bg-slate-100"
              >
                Close
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || loading}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#007ABE] px-4 text-xs font-bold text-white shadow-sm transition-colors hover:bg-[#0069a3] disabled:opacity-50"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
                {saving ? 'Saving…' : 'Save'}
              </button>
            </footer>
          </motion.section>
        </div>
      )}
    </AnimatePresence>
  );
}
