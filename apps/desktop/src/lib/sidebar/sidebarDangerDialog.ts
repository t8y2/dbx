import type { SidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";

export interface SidebarDangerDialogOption {
  checked: boolean;
  label: string;
  hint: string;
  compact?: boolean;
  danger?: boolean;
  onChange?: (checked: boolean) => void | Promise<void>;
}

export interface SidebarDangerDialogProgress {
  completed: number;
  total: number;
}

export interface SidebarDangerDialogTextInput {
  value: string;
  label: string;
  placeholder?: string;
  inputMode?: "text" | "numeric";
  onInput?: (value: string) => void | Promise<void>;
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
  /** Keeps the confirm button held back until the request's own precondition is met (e.g. a typed target name). */
  confirmDisabled?: boolean;
  closeOnConfirm?: boolean;
  progress?: SidebarDangerDialogProgress;
  option?: SidebarDangerDialogOption;
  options?: SidebarDangerDialogOption[];
  textInput?: SidebarDangerDialogTextInput;
  cancelRunning?: () => void | Promise<void>;
  confirm: () => void | boolean | Promise<void | boolean>;
}
