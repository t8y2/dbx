<script setup lang="ts">
import { computed } from "vue";
import { siPostgresql, siSqlite, siRedis, siMongodb, siClickhouse, siDuckdb, siMariadb, siTidb } from "simple-icons";
import { Database } from "lucide-vue-next";

const props = defineProps<{
  dbType: string;
}>();

const brandIcons: Record<string, { path: string; color: string; viewBox?: string }> = {
  mysql: {
    viewBox: "0 0 128 128",
    color: "#00618a",
    path: "M117.688 98.242c-6.973-.191-12.297.461-16.852 2.379c-1.293.547-3.355.559-3.566 2.18c.711.746.82 1.859 1.387 2.777c1.086 1.754 2.922 4.113 4.559 5.352c1.789 1.348 3.633 2.793 5.551 3.961c3.414 2.082 7.223 3.27 10.504 5.352c1.938 1.23 3.859 2.777 5.75 4.164c.934.684 1.563 1.75 2.773 2.18v-.195c-.637-.812-.801-1.93-1.387-2.777l-2.578-2.578c-2.52-3.344-5.719-6.281-9.117-8.719c-2.711-1.949-8.781-4.578-9.91-7.73l-.199-.199c1.922-.219 4.172-.914 5.949-1.391c2.98-.797 5.645-.59 8.719-1.387l4.164-1.187v-.793c-1.555-1.594-2.664-3.707-4.359-5.152c-4.441-3.781-9.285-7.555-14.273-10.703c-2.766-1.746-6.184-2.883-9.117-4.363c-.988-.496-2.719-.758-3.371-1.586c-1.539-1.961-2.379-4.449-3.566-6.738c-2.488-4.793-4.93-10.023-7.137-15.066c-1.504-3.437-2.484-6.828-4.359-9.91c-9-14.797-18.687-23.73-33.695-32.508c-3.195-1.867-7.039-2.605-11.102-3.57l-6.543-.395c-1.332-.555-2.715-2.184-3.965-2.977C16.977 3.52 4.223-3.312.539 5.672C-1.785 11.34 4.016 16.871 6.09 19.746c1.457 2.012 3.32 4.273 4.359 6.539c.688 1.492.805 2.984 1.391 4.559c1.438 3.883 2.695 8.109 4.559 11.695c.941 1.816 1.98 3.727 3.172 5.352c.727.996 1.98 1.438 2.18 2.973c-1.227 1.715-1.297 4.375-1.984 6.543c-3.098 9.77-1.926 21.91 2.578 29.137c1.383 2.223 4.641 6.98 9.117 5.156c3.918-1.598 3.043-6.539 4.164-10.902c.254-.988.098-1.715.594-2.379v.199l3.57 7.133c2.641 4.254 7.324 8.699 11.297 11.699c2.059 1.555 3.68 4.242 6.344 5.152v-.199h-.199c-.516-.805-1.324-1.137-1.98-1.781c-1.551-1.523-3.277-3.414-4.559-5.156c-3.613-4.902-6.805-10.27-9.711-15.855c-1.391-2.668-2.598-5.609-3.77-8.324c-.453-1.047-.445-2.633-1.387-3.172c-1.281 1.988-3.172 3.598-4.164 5.945c-1.582 3.754-1.789 8.336-2.375 13.082c-.348.125-.195.039-.398.199c-2.762-.668-3.73-3.508-4.758-5.949c-2.594-6.164-3.078-16.09-.793-23.191c.59-1.836 3.262-7.617 2.18-9.316c-.516-1.691-2.219-2.672-3.172-3.965c-1.18-1.598-2.355-3.703-3.172-5.551c-2.125-4.805-3.113-10.203-5.352-15.062c-1.07-2.324-2.875-4.676-4.359-6.738c-1.645-2.289-3.484-3.977-4.758-6.742c-.453-.984-1.066-2.559-.398-3.566c.215-.684.516-.969 1.191-1.191c1.148-.887 4.352.297 5.547.793c3.18 1.32 5.832 2.578 8.527 4.363c1.289.855 2.598 2.512 4.16 2.973h1.785c2.789.641 5.914.195 8.523.988c4.609 1.402 8.738 3.582 12.488 5.949c11.422 7.215 20.766 17.48 27.156 29.734c1.027 1.973 1.473 3.852 2.379 5.945c1.824 4.219 4.125 8.559 5.941 12.688c1.816 4.113 3.582 8.27 6.148 11.695c1.348 1.801 6.551 2.766 8.918 3.766c1.66.699 4.379 1.43 5.949 2.379c3 1.809 5.906 3.965 8.723 5.945c1.402.992 5.73 3.168 5.945 4.957zm-88.605-75.52c-1.453-.027-2.48.156-3.566.395v.199h.195c.695 1.422 1.918 2.34 2.777 3.566l1.98 4.164l.199-.195c1.227-.867 1.789-2.25 1.781-4.363c-.492-.52-.562-1.164-.992-1.785c-.562-.824-1.66-1.289-2.375-1.98z",
  },
  postgres: { path: siPostgresql.path, color: `#${siPostgresql.hex}` },
  sqlite: { path: siSqlite.path, color: `#${siSqlite.hex}` },
  redis: { path: siRedis.path, color: `#${siRedis.hex}` },
  mongodb: { path: siMongodb.path, color: `#${siMongodb.hex}` },
  clickhouse: { path: siClickhouse.path, color: `#${siClickhouse.hex}` },
  duckdb: { path: siDuckdb.path, color: `#${siDuckdb.hex}` },
  mariadb: { path: siMariadb.path, color: `#${siMariadb.hex}` },
  tidb: { path: siTidb.path, color: `#${siTidb.hex}` },
};

const letterIcons: Record<string, { letter: string; color: string }> = {
  sqlserver: { letter: "S", color: "#CC2927" },
  oceanbase: { letter: "O", color: "#0064FF" },
  opengauss: { letter: "G", color: "#34A853" },
  gaussdb: { letter: "G", color: "#CF0A2C" },
  kingbase: { letter: "K", color: "#1A56DB" },
  vastbase: { letter: "V", color: "#6D28D9" },
  goldendb: { letter: "G", color: "#F59E0B" },
};

const brand = computed(() => brandIcons[props.dbType]);
const letter = computed(() => letterIcons[props.dbType]);
</script>

<template>
  <svg v-if="brand" xmlns="http://www.w3.org/2000/svg" :viewBox="brand.viewBox || '0 0 24 24'" :fill="brand.color">
    <path :d="brand.path" />
  </svg>
  <svg v-else-if="letter" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
    <circle cx="12" cy="12" r="12" :fill="letter.color" />
    <text x="12" y="16.5" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="system-ui, sans-serif">{{ letter.letter }}</text>
  </svg>
  <Database v-else class="text-blue-400" />
</template>
