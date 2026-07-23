import React from 'react';
import { cn } from '../../lib/utils';
import type { Registration, RegColumnKey } from '../../types/forecast';
import { forecastBodyCellClass } from './forecastTableMetrics';
import { getRegistrationFieldValue } from './forecastFilterUtils';

const cellStyles: Partial<Record<RegColumnKey, string>> = {
  businessUnit: 'font-normal text-black',
  ownerName: 'font-semibold text-slate-700',
  registrationTopic: 'font-mono text-slate-500 text-[10px]',
  materialCode: 'font-mono text-slate-500 uppercase',
  plantCode: 'font-mono font-bold text-blue-700',
  onOffSpec: 'font-bold text-slate-600',
  spread: 'font-mono text-slate-700 justify-end',
  inventoryA0Qty: 'font-normal text-black justify-end',
  inventoryNonA0Qty: 'font-normal text-black justify-end',
  inventoryWaitJudgeQty: 'font-normal text-black justify-end',
  inventoryOgQty: 'font-normal text-black justify-end',
  inventoryYoQty: 'font-normal text-black justify-end',
  carryInETD: 'font-normal text-black justify-end',
  carryOutETD: 'font-normal text-black justify-end',
  carryInLoading: 'font-normal text-black justify-end',
  carryOutLoading: 'font-normal text-black justify-end',
};

function RegTableCellBase({
  reg,
  columnKey,
  width,
}: Readonly<{
  reg: Registration;
  columnKey: RegColumnKey;
  width: number;
}>) {
  const rawValue = reg[columnKey as keyof Registration];
  const isPendingInventory = columnKey.startsWith('inventory') && typeof rawValue !== 'number';
  const value = isPendingInventory ? '-' : getRegistrationFieldValue(reg, columnKey);
  return (
    <td
      style={{ width, minWidth: width, maxWidth: width }}
      className="p-0 border-r border-slate-100 bg-white align-middle overflow-hidden"
    >
      <div
        className={cn(
          forecastBodyCellClass,
          'truncate',
          cellStyles[columnKey] ?? 'text-slate-600'
        )}
        title={value}
      >
        <span className="truncate">{value}</span>
        {reg.isDraft && columnKey === 'ownerName' && (
          <span className="ml-1.5 shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[8px] font-black uppercase text-amber-700">
            Draft
          </span>
        )}
      </div>
    </td>
  );
}

export const RegTableCell = React.memo(RegTableCellBase, (previous, next) => {
  if (previous.width !== next.width || previous.columnKey !== next.columnKey) return false;
  if (previous.reg.id !== next.reg.id || previous.reg.isDraft !== next.reg.isDraft) return false;
  return previous.reg[previous.columnKey as keyof Registration] ===
    next.reg[next.columnKey as keyof Registration];
});
