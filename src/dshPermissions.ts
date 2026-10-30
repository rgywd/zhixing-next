export type DshPermission = "read-only" | "workspace-write" | "danger-full-access";
export type DshPermissions = { current: string; options: string[] };

export const permissionChoices = [
  { value: "read-only", label: "仅可查看", icon: "eye-outline", description: "查看文件与信息；需要扩大权限的操作由你批准。" },
  { value: "workspace-write", label: "工作区内修改", icon: "hand-left-outline", description: "可在工作区内修改；需提权的危险操作由你手动批准。" },
  { value: "danger-full-access", label: "完全访问", icon: "shield", description: "允许完整访问，执行操作时不再请求批准。" },
] as const;

export function permissionPresentation(value?: string) {
  return permissionChoices.find(choice => choice.value === value)
    ?? { label: value ? "宿主自定义权限" : "权限未就绪", icon: "help-circle-outline" as const };
}
