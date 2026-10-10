<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import { useQueryStore } from "@/stores/queryStore";
import type { OracleTypeDetails } from "@/types/oracleTypes";

const props = defineProps<{ connectionId: string; database: string; schema: string; name: string; objectType: "TYPE" | "TYPE_BODY" }>();
const { t } = useI18n({
  useScope: "local",
  messages: {
    en: {
      edit: "Edit definitions",
      title: "Type metadata",
      status: "Status",
      pair: "Paired definition",
      dependencies: "Visible outgoing dependencies",
      grants: "Visible object grants",
      limited: "Current account visibility only. Grants do not include effective role inheritance.",
      refresh: "Refresh",
      cancel: "Cancel",
      cancelled: "Cancelled",
      grantable: "Grant option",
      available: "Available",
      empty: "No visible rows",
      unknown: "Unknown",
      unsupported: "Unsupported",
      denied: "Permission denied",
      error: "Read failed",
      loading: "Loading",
    },
    "zh-CN": {
      edit: "编辑定义",
      title: "类型元数据",
      status: "状态",
      pair: "配对定义",
      dependencies: "当前可见的出向依赖",
      grants: "当前可见的对象授权",
      limited: "仅展示当前账号可见范围，授权未计算角色继承后的有效权限。",
      refresh: "刷新",
      cancel: "取消",
      cancelled: "已取消",
      grantable: "可转授",
      available: "可读取",
      empty: "无可见记录",
      unknown: "未知",
      unsupported: "不支持",
      denied: "无权限",
      error: "读取失败",
      loading: "加载中",
    },
    "zh-TW": {
      title: "型別中繼資料",
      status: "狀態",
      pair: "配對定義",
      dependencies: "目前可見的向外相依關係",
      grants: "目前可見的物件授權",
      limited: "僅顯示目前帳號可見範圍，授權未計算角色繼承後的有效權限。",
      refresh: "重新整理",
      cancel: "取消",
      cancelled: "已取消",
      grantable: "可轉授",
      available: "可讀取",
      empty: "無可見記錄",
      unknown: "未知",
      unsupported: "不支援",
      denied: "無權限",
      error: "讀取失敗",
      loading: "載入中",
    },
    es: {
      title: "Metadatos del tipo",
      status: "Estado",
      pair: "Definición asociada",
      dependencies: "Dependencias salientes visibles",
      grants: "Permisos de objeto visibles",
      limited: "Solo se muestra lo visible para la cuenta actual. No se calculan los permisos heredados de roles.",
      refresh: "Actualizar",
      cancel: "Cancelar",
      cancelled: "Cancelado",
      grantable: "Opción de concesión",
      available: "Disponible",
      empty: "Sin registros visibles",
      unknown: "Desconocido",
      unsupported: "No compatible",
      denied: "Permiso denegado",
      error: "Error de lectura",
      loading: "Cargando",
    },
    it: {
      title: "Metadati del tipo",
      status: "Stato",
      pair: "Definizione associata",
      dependencies: "Dipendenze in uscita visibili",
      grants: "Privilegi oggetto visibili",
      limited: "Solo dati visibili all'account corrente. I privilegi ereditati dai ruoli non vengono calcolati.",
      refresh: "Aggiorna",
      cancel: "Annulla",
      cancelled: "Annullato",
      grantable: "Opzione di concessione",
      available: "Disponibile",
      empty: "Nessun record visibile",
      unknown: "Sconosciuto",
      unsupported: "Non supportato",
      denied: "Permesso negato",
      error: "Lettura non riuscita",
      loading: "Caricamento",
    },
    ja: {
      title: "型メタデータ",
      status: "状態",
      pair: "対応する定義",
      dependencies: "参照可能な依存先",
      grants: "参照可能なオブジェクト権限",
      limited: "現在のアカウントで参照できる情報のみ表示します。ロールから継承する実効権限は計算しません。",
      refresh: "更新",
      cancel: "キャンセル",
      cancelled: "キャンセル済み",
      grantable: "権限付与オプション",
      available: "取得可能",
      empty: "参照可能なレコードなし",
      unknown: "不明",
      unsupported: "未対応",
      denied: "権限なし",
      error: "読み取り失敗",
      loading: "読み込み中",
    },
    ko: {
      title: "타입 메타데이터",
      status: "상태",
      pair: "연결된 정의",
      dependencies: "조회 가능한 참조 대상",
      grants: "조회 가능한 객체 권한",
      limited: "현재 계정에서 조회 가능한 정보만 표시합니다. 역할에서 상속된 유효 권한은 계산하지 않습니다.",
      refresh: "새로 고침",
      cancel: "취소",
      cancelled: "취소됨",
      grantable: "권한 부여 옵션",
      available: "조회 가능",
      empty: "조회 가능한 레코드 없음",
      unknown: "알 수 없음",
      unsupported: "지원하지 않음",
      denied: "권한 없음",
      error: "읽기 실패",
      loading: "불러오는 중",
    },
    "pt-BR": {
      title: "Metadados do tipo",
      status: "Estado",
      pair: "Definição associada",
      dependencies: "Dependências de saída visíveis",
      grants: "Permissões de objeto visíveis",
      limited: "Somente dados visíveis para a conta atual. As permissões herdadas de funções não são calculadas.",
      refresh: "Atualizar",
      cancel: "Cancelar",
      cancelled: "Cancelado",
      grantable: "Opção de concessão",
      available: "Disponível",
      empty: "Nenhum registro visível",
      unknown: "Desconhecido",
      unsupported: "Não suportado",
      denied: "Permissão negada",
      error: "Falha na leitura",
      loading: "Carregando",
    },
    ru: {
      title: "Метаданные типа",
      status: "Состояние",
      pair: "Связанное определение",
      dependencies: "Видимые исходящие зависимости",
      grants: "Видимые права на объект",
      limited: "Показаны только данные, доступные текущей учётной записи. Права, унаследованные от ролей, не вычисляются.",
      refresh: "Обновить",
      cancel: "Отмена",
      cancelled: "Отменено",
      grantable: "Право передачи",
      available: "Доступно",
      empty: "Нет видимых записей",
      unknown: "Неизвестно",
      unsupported: "Не поддерживается",
      denied: "Нет доступа",
      error: "Ошибка чтения",
      loading: "Загрузка",
    },
  },
});
const details = ref<OracleTypeDetails | null>(null);
const loading = ref(false);
const error = ref("");
let serial = 0;
let executionId: string | undefined;

function cancel(showMessage = true) {
  ++serial;
  if (executionId) void api.cancelQuery(executionId).catch(() => undefined);
  executionId = undefined;
  loading.value = false;
  if (showMessage) error.value = t("cancelled");
}

async function load() {
  cancel(false);
  const current = serial;
  const target = { ...props };
  details.value = null;
  error.value = "";
  loading.value = true;
  try {
    executionId = `oracle-type-${uuid()}`;
    const result = await api.getOracleTypeDetails(target.connectionId, target.database, target.schema, target.name, target.objectType, executionId);
    if (current === serial) details.value = result;
  } catch (cause) {
    if (current === serial) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (current === serial) {
      loading.value = false;
      executionId = undefined;
    }
  }
}

watch(() => [props.connectionId, props.database, props.schema, props.name, props.objectType], load, { immediate: true });
onBeforeUnmount(() => cancel(false));
</script>

<template>
  <section class="max-h-64 shrink-0 overflow-auto border-b px-3 py-2 text-xs" data-oracle-type-metadata>
    <div class="flex items-center gap-2">
      <span class="flex-1 font-medium">{{ t("title") }}</span>
      <Button variant="ghost" size="sm" class="h-6 text-xs" @click="useQueryStore().openOracleTypeEditor(connectionId, database, schema, name)">{{ t("edit") }}</Button>
      <Button v-if="loading" variant="ghost" size="sm" class="h-6 text-xs" @click="cancel()">{{ t("cancel") }}</Button>
      <Button v-else variant="ghost" size="sm" class="h-6 text-xs" @click="load">{{ t("refresh") }}</Button>
    </div>
    <p v-if="loading" role="status">{{ t("loading") }}</p>
    <p v-else-if="error" role="alert" class="break-words text-destructive">{{ error }}</p>
    <template v-else-if="details">
      <p>{{ t("status") }}: {{ details.status ?? t("unknown") }}</p>
      <p>{{ t("pair") }}: {{ details.paired_object ? `${details.paired_object.schema}.${details.paired_object.name} (${details.paired_object.object_type})` : t(details.pairing_state) }}</p>
      <p class="my-1 text-muted-foreground">{{ t("limited") }}</p>
      <details>
        <summary class="cursor-pointer">{{ t("dependencies") }} ({{ details.dependencies.rows.length }}) · {{ t(details.dependencies.state) }}</summary>
        <p v-if="details.dependencies.message" class="break-words text-destructive">{{ details.dependencies.message }}</p>
        <ul class="space-y-1 py-1">
          <li v-for="(dependency, index) in details.dependencies.rows" :key="index" class="break-all font-mono">
            {{ dependency.referenced_schema ?? t("unknown") }}.{{ dependency.referenced_name }} ({{ dependency.referenced_type }}){{ dependency.referenced_link ? ` @${dependency.referenced_link}` : "" }}
          </li>
        </ul>
      </details>
      <details>
        <summary class="cursor-pointer">{{ t("grants") }} ({{ details.grants.rows.length }}) · {{ t(details.grants.state) }}</summary>
        <p v-if="details.grants.message" class="break-words text-destructive">{{ details.grants.message }}</p>
        <ul class="space-y-1 py-1">
          <li v-for="(grant, index) in details.grants.rows" :key="index" class="break-all font-mono">{{ grant.grantee }}: {{ grant.privilege }} · {{ t("grantable") }}: {{ grant.grantable == null ? t("unknown") : grant.grantable ? "YES" : "NO" }}</li>
        </ul>
      </details>
    </template>
  </section>
</template>
