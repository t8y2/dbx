import type { SidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";

export interface SidebarDangerDialogOption {
  checked: boolean;
  label: string;
  hint: string;
  onChange?: (checked: boolean) => void | Promise<void>;
}

export interface SidebarDangerDialogProgress {
  completed: number;
  total: number;
}

export interface SidebarDangerDialogRequest {
  target: SidebarActionTarget;
  title: string;
  message: string;
  confirmLabel: string;
  sql?: string;
  details?: string;
  detailsText?: string;
  loading?: boolean;
  closeOnConfirm?: boolean;
  progress?: SidebarDangerDialogProgress;
  option?: SidebarDangerDialogOption;
  confirm: () => void | Promise<void>;
}
