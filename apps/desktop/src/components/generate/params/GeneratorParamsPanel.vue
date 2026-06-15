<script setup lang="ts">
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "@lucide/vue";
import type { ColumnGenerateConfig, GeneratorParams } from "@/lib/dataGenerate";
import GeneratorSelect from "../GeneratorSelect.vue";
import NumberParams from "./NumberParams.vue";
import DateTimeParams from "./DateTimeParams.vue";
import DateParams from "./DateParams.vue";
import TimeParams from "./TimeParams.vue";
import SequenceParams from "./SequenceParams.vue";
import EnumParams from "./EnumParams.vue";
import TextParams from "./TextParams.vue";
import ImageBinaryParams from "./ImageBinaryParams.vue";
import ForeignKeyParams from "./ForeignKeyParams.vue";
import UuidParams from "./UuidParams.vue";
import RegexParams from "./RegexParams.vue";
import FullNameParams from "./FullNameParams.vue";
import GenderParams from "./GenderParams.vue";
import TitleParams from "./TitleParams.vue";
import MaritalStatusParams from "./MaritalStatusParams.vue";
import PhoneParams from "./PhoneParams.vue";
import EmailParams from "./EmailParams.vue";
import JobTitleParams from "./JobTitleParams.vue";
import SocialIdParams from "./SocialIdParams.vue";
import PaymentMethodParams from "./PaymentMethodParams.vue";
import CreditCardTypeParams from "./CreditCardTypeParams.vue";
import CreditCardNumberParams from "./CreditCardNumberParams.vue";
import CreditCardDateParams from "./CreditCardDateParams.vue";
import CompanyNameParams from "./CompanyNameParams.vue";
import DepartmentParams from "./DepartmentParams.vue";
import IndustryParams from "./IndustryParams.vue";
import AddressParams from "./AddressParams.vue";
import CityParams from "./CityParams.vue";
import RegionParams from "./RegionParams.vue";
import ProductNameParams from "./ProductNameParams.vue";
import ProductCategoryParams from "./ProductCategoryParams.vue";
import ColorParams from "./ColorParams.vue";
import SizeParams from "./SizeParams.vue";
import WeightUnitParams from "./WeightUnitParams.vue";
import BarcodeParams from "./BarcodeParams.vue";
import SkuParams from "./SkuParams.vue";
import IpAddressParams from "./IpAddressParams.vue";
import MacAddressParams from "./MacAddressParams.vue";
import FilePathParams from "./FilePathParams.vue";
import FileNameParams from "./FileNameParams.vue";
import FileExtensionParams from "./FileExtensionParams.vue";
import UrlParams from "./UrlParams.vue";
import HostnameParams from "./HostnameParams.vue";
import DefaultParams from "./DefaultParams.vue";

const { t } = useI18n();
const props = defineProps<{ config: ColumnGenerateConfig; connectionId?: string; database?: string }>();

function initParams() {
  if (!props.config.generatorParams) {
    props.config.generatorParams = {} as GeneratorParams;
  }
  return props.config.generatorParams;
}

const key = computed(() => props.config.generatorKey);

watch(key, (newKey, oldKey) => {
  if (newKey && newKey !== oldKey) {
    resetParams();
  }
});

function resetParams() {
  props.config.generatorParams = {} as GeneratorParams;
}

const componentMap: Record<string, any> = {
  number: NumberParams,
  datetime: DateTimeParams,
  date: DateParams,
  time: TimeParams,
  sequence: SequenceParams,
  enum: EnumParams,
  text: TextParams,
  image: ImageBinaryParams,
  foreign_key: ForeignKeyParams,
  uuid: UuidParams,
  regex: RegexParams,
  full_name: FullNameParams,
  gender: GenderParams,
  title: TitleParams,
  marital_status: MaritalStatusParams,
  phone: PhoneParams,
  email: EmailParams,
  job_title: JobTitleParams,
  social_id: SocialIdParams,
  payment_method: PaymentMethodParams,
  credit_card_type: CreditCardTypeParams,
  credit_card_number: CreditCardNumberParams,
  credit_card_date: CreditCardDateParams,
  company_name: CompanyNameParams,
  department: DepartmentParams,
  industry: IndustryParams,
  address: AddressParams,
  city: CityParams,
  region: RegionParams,
  product_name: ProductNameParams,
  product_category: ProductCategoryParams,
  color: ColorParams,
  size: SizeParams,
  weight_unit: WeightUnitParams,
  barcode: BarcodeParams,
  sku: SkuParams,
  ip_address: IpAddressParams,
  mac_address: MacAddressParams,
  file_path: FilePathParams,
  file_name: FileNameParams,
  file_extension: FileExtensionParams,
  url: UrlParams,
  hostname: HostnameParams,
};
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3">
      <div class="grid grid-cols-[80px_1fr_auto] items-center gap-2 text-xs">
        <span class="text-muted-foreground">{{ t("dataGenerate.generator") }}</span>
        <GeneratorSelect v-model="config.generatorKey" />
        <Button variant="outline" size="sm" class="h-7 text-xs gap-1" @click="resetParams">
          <RotateCcw class="h-3 w-3" />
          {{ t("dataGenerate.reset") }}
        </Button>
      </div>
    </div>

    <component :is="componentMap[key!] ?? DefaultParams" v-if="key" :params="initParams()" :config="config" :connection-id="connectionId" :database="database" />
    <div v-else class="text-xs text-muted-foreground px-1 py-3 text-center border rounded-md bg-muted/5">{{ t("dataGenerate.selectGeneratorHint") }}</div>
  </div>
</template>
