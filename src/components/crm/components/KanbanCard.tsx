import { useState } from 'react';
import { Building2, CalendarDays, GripVertical, Pencil, User } from 'lucide-react';
import type { CRMDeal } from '../../../types/crm';
import type { CRMContact, CRMCompany } from '../../../types/crm';
import { TagChips } from './TagChips';

interface KanbanCardProps {
  deal: CRMDeal;
  /** Resolved contact (used to show the linked person). */
  contact?: CRMContact;
  /** Resolved company (used to show the company name). */
  company?: CRMCompany;
  onClick?: (dealId: string) => void;
  onEdit?: (dealId: string) => void;
  isActive?: boolean;
}

function formatValue(value?: number, currency = 'USD'): string {
  if (value === undefined || value === null) return '—';
  const compact = value >= 1000 ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value) : String(value);
  const symbol = currency === 'USD' ? '$' : '';
  return `${symbol}${compact}`;
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function KanbanCard({ deal, contact, company, onClick, onEdit, isActive }: KanbanCardProps) {
  const companyLabel = company?.name ?? deal.companyId ?? '—';
  const contactLabel = contact ? `${contact.firstName} ${contact.lastName}` : deal.contactId ?? '—';
  const [isDragging, setIsDragging] = useState(false);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', deal.id);
    e.dataTransfer.setData('application/x-crm-deal', deal.id);
    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  return (
    <div
      className={`crm-kanban-card${isActive ? ' crm-kanban-card--active' : ''}${isDragging ? ' crm-kanban-card--dragging' : ''}`}
      onClick={() => onClick?.(deal.id)}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      draggable
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <div className="crm-kanban-card-drag" title="Drag to move">
        <GripVertical size={12} />
      </div>
      <div className="crm-kanban-card-title-zone">
        <span className="crm-kanban-card-title">{deal.title}</span>
        {onEdit && (
          <button
            type="button"
            className="crm-kanban-card-edit"
            title="Edit lead"
            aria-label="Edit lead"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(deal.id);
            }}
          >
            <Pencil size={12} />
          </button>
        )}
      </div>
      <div className="crm-kanban-card-primary">
        <div className="crm-kanban-card-value">{formatValue(deal.value, deal.currency)}</div>
      </div>
      <div className="crm-kanban-card-footer">
        <span className="crm-kanban-card-meta-item">
          <Building2 size={11} />
          <span className="trunc">{companyLabel}</span>
        </span>
        <span className="crm-kanban-card-meta-item">
          <User size={11} />
          <span className="trunc">{contactLabel}</span>
        </span>
        <span className="crm-kanban-card-meta-item">
          <CalendarDays size={11} />
          <span>{formatDate(deal.expectedCloseDate)}</span>
        </span>
        {deal.tags.length > 0 && (
          <div className="crm-kanban-card-tags">
            <TagChips tags={deal.tags} max={2} />
          </div>
        )}
      </div>
    </div>
  );
}
