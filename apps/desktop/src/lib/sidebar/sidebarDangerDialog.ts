import type { SidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";

export interface SidebarDangerDialogOption {
  checked: boolean;
  label: string;
  hint: string;
  onChange?: (checked: boolean) => void | Promise<void>;
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
  option?: SidebarDangerDialogOption;
  confirm: () => void | Promise<void>;
}
