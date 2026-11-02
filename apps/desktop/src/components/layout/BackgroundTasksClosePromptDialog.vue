<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// 后台任务（数据传输/导出等）运行中退出软件的确认框（#13281）。
// 与 AiRunsClosePromptDialog 同构：cancel 回滚关闭流程，quit 由调用方先
// 尽力取消任务再继续退出。
defineProps<{ count: number }>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ cancel: []; quit: [] }>();
const { t } = useI18n();
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[440px]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("app.closeWithBackgroundTasksTitle") }}</DialogTitle>
        <DialogDescription>{{ t("app.closeWithBackgroundTasksDescription", { count }) }}</DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2 sm:gap-2">
        <Button type="button" variant="outline" @click="emit('cancel')">{{ t("common.cancel") }}</Button>
        <Button type="button" variant="destructive" @click="emit('quit')">{{ t("app.closeWithBackgroundTasksQuit") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
