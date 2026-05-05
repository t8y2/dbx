<script setup lang="ts">
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatabaseZap } from "lucide-vue-next";

const emit = defineEmits<{ authenticated: [] }>();

const password = ref("");
const error = ref("");
const loading = ref(false);

async function login() {
  loading.value = true;
  error.value = "";
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: password.value }),
    });
    if (res.ok) {
      emit("authenticated");
    } else {
      const text = await res.text();
      error.value = text || "密码错误";
    }
  } catch (e: any) {
    error.value = e?.message || "连接失败";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex items-center justify-center h-screen bg-background">
    <div class="w-80 space-y-6 text-center">
      <div class="flex items-center justify-center gap-2 text-2xl font-bold">
        <DatabaseZap class="w-8 h-8" />
        <span>DBX</span>
      </div>
      <form class="space-y-4" @submit.prevent="login">
        <Input
          v-model="password"
          type="password"
          placeholder="请输入访问密码"
          autofocus
        />
        <p v-if="error" class="text-sm text-destructive">{{ error }}</p>
        <Button type="submit" class="w-full" :disabled="loading || !password">
          {{ loading ? "登录中..." : "登录" }}
        </Button>
      </form>
    </div>
  </div>
</template>
