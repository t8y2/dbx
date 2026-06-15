import type { DatabaseType } from "@/types/database";
import { quoteTableIdentifier } from "@/lib/tableSelectSql";

export interface GeneratorNode {
  key: string;
  label: string;
  children?: GeneratorNode[];
}

export const GeneratorHierarchy: GeneratorNode[] = [
  {
    key: "general",
    label: "通用",
    children: [
      { key: "number", label: "数字" },
      { key: "datetime", label: "日期时间" },
      { key: "date", label: "日期" },
      { key: "time", label: "时间" },
      { key: "sequence", label: "序列" },
      { key: "enum", label: "枚举" },
      { key: "text", label: "文本" },
      { key: "image", label: "图像或二进制" },
      { key: "foreign_key", label: "外键" },
      { key: "uuid", label: "UUID" },
      { key: "regex", label: "正则表达式" },
    ],
  },
  {
    key: "personal",
    label: "个人",
    children: [
      { key: "full_name", label: "姓名" },
      { key: "gender", label: "性别" },
      { key: "title", label: "称谓" },
      { key: "marital_status", label: "婚姻状况" },
      { key: "phone", label: "电话号码" },
      { key: "email", label: "电子邮箱" },
      { key: "job_title", label: "职位名称" },
      { key: "social_id", label: "社交网络ID" },
    ],
  },
  {
    key: "payment",
    label: "支付",
    children: [
      { key: "payment_method", label: "支付方式" },
      { key: "credit_card_type", label: "信用卡类型" },
      { key: "credit_card_number", label: "信用卡卡号" },
      { key: "credit_card_date", label: "信用卡日期" },
    ],
  },
  {
    key: "business",
    label: "商业",
    children: [
      { key: "company_name", label: "公司名称" },
      { key: "department", label: "部门" },
      { key: "industry", label: "行业" },
    ],
  },
  {
    key: "location",
    label: "位置",
    children: [
      { key: "address", label: "地址" },
      { key: "city", label: "城市" },
      { key: "region", label: "地区" },
    ],
  },
  {
    key: "product",
    label: "产品",
    children: [
      { key: "product_name", label: "产品名称" },
      { key: "product_category", label: "产品类别" },
      { key: "color", label: "颜色" },
      { key: "size", label: "尺寸" },
      { key: "weight_unit", label: "重量单位" },
      { key: "barcode", label: "条码" },
      { key: "sku", label: "SKU" },
    ],
  },
  {
    key: "computer",
    label: "电脑",
    children: [
      { key: "ip_address", label: "IP地址" },
      { key: "mac_address", label: "MAC地址" },
      { key: "file_path", label: "文件路径" },
      { key: "file_name", label: "文件名称" },
      { key: "file_extension", label: "文件扩展名" },
      { key: "url", label: "网址" },
      { key: "hostname", label: "主机名" },
    ],
  },
];

export interface GeneratorParams {
  // number / decimal
  numberType?: "integer" | "decimal";
  decimalPlaces?: number;
  // range
  start?: string;
  end?: string;
  min?: number;
  max?: number;
  // text
  minLength?: number;
  maxLength?: number;
  // date/time
  allDay?: boolean;
  startTime?: string;
  endTime?: string;
  weekdayMode?: "all" | "weekday" | "custom";
  weekdays?: number[];
  // sequence
  startValue?: number;
  increment?: number;
  sequenceMin?: number;
  sequenceMax?: number;
  sequenceCycle?: boolean;
  // enum
  values?: string;
  // regex
  pattern?: string;
  rawPattern?: boolean;
  // uuid
  uuidHyphens?: boolean;
  // name
  nameFormat?: "full" | "last" | "first";
  languages?: string[];
  // phone
  phoneFormat?: "domestic" | "international";
  phoneSeparator?: boolean;
  phoneRegions?: string[];
  // email
  emailDomains?: string;
  // image
  imageMode?: "generate" | "folder";
  imageWidth?: number;
  imageHeight?: number;
  imageFormat?: "JPEG" | "PNG";
  folderPath?: string;
  fileExtensions?: string;
  // foreign key
  fkSchema?: string;
  fkTable?: string;
  fkField?: string;
  fkMode?: "random" | "unique" | "repeat";
  fkRepeatMin?: number;
  fkRepeatMax?: number;
  // credit card / payment
  cardTypes?: string[];
  ccDateFormat?: string;
  ccYearOffsetMin?: number;
  ccYearOffsetMax?: number;
  // address / location
  addressType?: string;
  regions?: string[];
  // region / country
  regionFormat?: string;
  regionLang?: string;
  textTransform?: string;
  // product
  productKeywords?: string;
  // barcode / sku
  barcodeTypes?: string[];
  // ip
  ipType?: string;
  // mac / file / url
  pathTypes?: string[];
  includeFileName?: boolean;
  includeExtension?: boolean;
  extensionCategory?: string;
  urlSubdomains?: string;
  urlTlds?: string;
  // common options
  includeDefault?: boolean;
  defaultPercent?: number;
  includeNull?: boolean;
  nullPercent?: number;
  unique?: boolean;
  disableLinks?: boolean;
}

export interface ColumnGenerateConfig {
  columnName: string;
  dataType: string;
  rowCount: number;
  generatorKey?: string;
  generatorLabel?: string;
  generatorCategory?: string;
  generatorCategoryLabel?: string;
  generatorParams?: GeneratorParams;
  isAutoIncrement?: boolean;
}

export interface TableGenerateConfig {
  tableName: string;
  schema: string;
  database: string;
  rowCount: number;
  columns: ColumnGenerateConfig[];
}

const firstNames = ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda", "David", "Elizabeth", "William", "Barbara", "Richard", "Susan", "Joseph", "Jessica", "Thomas", "Sarah", "Christopher", "Karen"];
const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin"];
const domains = ["gmail.com", "yahoo.com", "outlook.com", "example.com", "test.org"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
export function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randDigit(): number {
  return Math.floor(Math.random() * 10);
}
export function randDecimal(min: number, max: number, decimals: number): number {
  return parseFloat((Math.random() * (max - min) + min).toFixed(decimals));
}
function parseLocalDate(str: string): Date {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ensureRange(start: Date, end: Date): [Date, Date] {
  if (start.getTime() > end.getTime()) {
    console.warn("[dbx] date range reversed, swapping start/end", start, end);
    return [end, start];
  }
  return [start, end];
}

function randDate(start: Date, end: Date): string {
  [start, end] = ensureRange(start, end);
  return formatLocalDate(new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime())));
}

function randTimestamp(start: Date, end: Date): string {
  [start, end] = ensureRange(start, end);
  const d = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
  const date = formatLocalDate(d);
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${date} ${h}:${min}:${s}`;
}
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Credit card data
const ccPrefixMap: Record<string, string[]> = {
  american_express: ["34", "37"],
  jcb: ["3528", "3529", "3530", "3531", "3532", "3533", "3534", "3535", "3536", "3537", "3538", "3539"],
  mastercard: ["51", "52", "53", "54", "55", "2221", "2222", "2223", "2224", "2225", "2226", "2227", "2228", "2229", "23", "24", "25", "26", "270", "271", "2720"],
  unionpay: ["62", "623", "624", "625", "626", "627", "628"],
  visa: ["4"],
};
const ccLengthMap: Record<string, number> = {
  american_express: 15,
  jcb: 16,
  mastercard: 16,
  unionpay: 16,
  visa: 16,
};
const ccLabelMap: Record<string, string> = {
  american_express: "American Express",
  jcb: "JCB",
  mastercard: "MasterCard",
  unionpay: "UnionPay",
  visa: "Visa",
};

function luhnCheck(numStr: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = numStr.length - 1; i >= 0; i--) {
    let d = parseInt(numStr.charAt(i), 10);
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function generateLuhnCard(prefix: string, length: number): string {
  const body: number[] = prefix.split("").map((c) => parseInt(c, 10));
  while (body.length < length - 1) body.push(randDigit());
  for (let check = 0; check < 10; check++) {
    const candidate = body.join("") + String(check);
    if (luhnCheck(candidate)) return candidate;
  }
  return body.join("") + "0";
}

// Company name word banks
const companyPrefixes: Record<string, string[]> = {
  en: ["Alpha", "Beta", "Global", "Prime", "Apex", "Nexus", "Atlas", "Vertex", "Zenith", "Acme"],
  zh_pinyin: ["Hua", "Zhong", "Da", "Xin", "Guo", "Tai", "Sheng", "Long", "Dong", "Nan"],
  zh_eng: ["Hua", "Zhong", "Da", "Xin", "Great", "New", "China", "Oriental", "Pacific", "Golden"],
  zh_hans: ["华", "中", "大", "新", "国", "泰", "盛", "龙", "东方", "金"],
  ja_romaji: ["Abe", "Sato", "Suzuki", "Takahashi", "Tanaka", "Watanabe", "Ito", "Yamamoto"],
  ja: ["アベ", "サトウ", "スズキ", "タカハシ", "タナカ", "ワタナベ"],
};
const companyMiddles: Record<string, string[]> = {
  en: ["Consulting", "Technologies", "Solutions", "Enterprises", "Industries", "Systems", "Holdings", "Services", "Digital", "Media"],
  zh_pinyin: ["Keji", "Shangmao", "Gongcheng", "Fuwu", "Zixun", "Chuangxin", "Touzi", "Wenhua", "Dianzi"],
  zh_eng: ["Tech", "Trading", "Industry", "Services", "Consulting", "Investment", "Digital", "Media", "Enterprise"],
  zh_hans: ["科技", "商贸", "工程", "服务", "咨询", "创新", "投资", "文化", "电子"],
  ja_romaji: ["Kigyo", "Sangyo", "Service", "Tech", "Consulting", "Media", "Digital", "System"],
  ja: ["企業", "産業", "サービス", "テック", "コンサルティング", "メディア"],
};
const companySuffixes: Record<string, string[]> = {
  en: ["Inc.", "Ltd.", "Corporation", "Company", "LLC", "Group"],
  zh_pinyin: ["Gongsi", "Jituan", "Youxian gongsi"],
  zh_eng: ["Co., Ltd.", "Inc.", "Ltd.", "Corporation", "Group"],
  zh_hans: ["有限公司", "股份有限公司", "集团", "公司"],
  ja_romaji: ["K.K.", "Co., Ltd.", "Kabushiki-gaisha"],
  ja: ["株式会社", "合同会社", "有限会社"],
};

function generateCompanyName(lang: string): string {
  const pf = companyPrefixes[lang] ?? companyPrefixes["en"];
  const md = companyMiddles[lang] ?? companyMiddles["en"];
  const sf = companySuffixes[lang] ?? companySuffixes["en"];
  return `${pick(pf)} ${pick(md)} ${pick(sf)}`.trim();
}

// Department / industry data
const departmentByLang: Record<string, string[]> = {
  en: ["Engineering", "Marketing", "Sales", "Human Resources", "Finance", "Operations", "Research and Development", "Customer Support", "Legal", "IT", "Design", "Purchasing"],
  zh: ["研发部", "市场部", "销售部", "人力资源部", "财务部", "运营部", "研发中心", "客户支持部", "法务部", "信息技术部", "设计部", "采购部"],
  zh_hant: ["研發部", "市場部", "銷售部", "人力資源部", "財務部", "營運部", "研發中心", "客戶支援部", "法務部", "資訊技術部", "設計部", "採購部"],
  ja: ["エンジニアリング", "マーケティング", "営業", "人事", "経理", "オペレーション", "研究開発", "カスタマーサポート", "法務", "IT", "デザイン", "購買"],
};

const industryByLang: Record<string, string[]> = {
  en: ["Technology", "Healthcare", "Finance", "Education", "Manufacturing", "Retail", "Media", "Energy", "Real Estate", "Transportation", "Telecommunications", "Agriculture", "Hospitality", "Pharmaceutical", "Automotive", "Logistics", "Construction", "Entertainment"],
  zh: ["科技", "医疗保健", "金融", "教育", "制造业", "零售", "媒体", "能源", "房地产", "交通运输", "电信", "农业", "酒店业", "制药", "汽车", "物流", "建筑", "娱乐"],
  zh_hant: ["科技", "醫療保健", "金融", "教育", "製造業", "零售", "媒體", "能源", "房地產", "交通運輸", "電信", "農業", "酒店業", "製藥", "汽車", "物流", "建築", "娛樂"],
  ja: ["テクノロジー", "医療", "金融", "教育", "製造業", "小売", "メディア", "エネルギー", "不動産", "運輸", "通信", "農業", "ホスピタリティ", "製薬", "自動車", "物流", "建設", "エンターテイメント"],
};

// Address data
const addressStreets: Record<string, string[]> = {
  us: ["Main St", "Oak Ave", "Elm Rd", "Park Blvd", "Lake Dr", "Hill St", "Washington Blvd", "2nd Ave"],
  uk: ["Oxford Street", "Abbey Road", "Baker Street", "Piccadilly", "Downing Street", "Regent Street"],
  cn: ["No. 88, YuShuang Road", "No. 128, Nanjing West Road", "No. 56, RenMin Avenue", "No. 201, ZhongShan Road"],
  jp: ["1-1-1, Marunouchi", "2-3-1, Shibuya", "3-2-1, Ginza", "1-5-2, Shinjuku"],
};
const addressApts: Record<string, string[]> = {
  us: ["Apt #203", "Unit 5", "Suite 300", "#4B", "Floor 7"],
  uk: ["Flat 3", "Apartment 5B", "Studio 2", "Suite 12"],
  cn: ["Building A, Unit 301", "Room 202, Block B", "Unit 1105"],
  jp: ["Building #2, 3F", "Room 402", "Tower A, 15F"],
};

function generateAddress(type: string, region: string): string {
  const streets = addressStreets[region] ?? addressStreets["us"];
  const apts = addressApts[region] ?? addressApts["us"];
  if (type === "line1") {
    if (region === "cn" || region === "jp") return pick(streets);
    return `${randInt(1, 9999)} ${pick(streets)}`;
  }
  if (type === "line2") return pick(apts);
  if (region === "cn" || region === "jp") return `${randInt(1, 999)} ${pick(streets)}, ${pick(apts)}`;
  return `${randInt(1, 9999)} ${pick(streets)}, ${pick(apts)}`;
}

// City data
const cityData: Record<string, { en: string; native: string }[]> = {
  us: [
    { en: "New York", native: "New York" },
    { en: "Los Angeles", native: "Los Angeles" },
    { en: "Chicago", native: "Chicago" },
    { en: "San Francisco", native: "San Francisco" },
    { en: "Boston", native: "Boston" },
    { en: "Seattle", native: "Seattle" },
    { en: "Washington, D.C.", native: "Washington, D.C." },
    { en: "Miami", native: "Miami" },
  ],
  uk: [
    { en: "London", native: "London" },
    { en: "Manchester", native: "Manchester" },
    { en: "Birmingham", native: "Birmingham" },
    { en: "Liverpool", native: "Liverpool" },
    { en: "Edinburgh", native: "Edinburgh" },
    { en: "Glasgow", native: "Glasgow" },
  ],
  cn: [
    { en: "Beijing", native: "北京" },
    { en: "Shanghai", native: "上海" },
    { en: "Guangzhou", native: "广州" },
    { en: "Shenzhen", native: "深圳" },
    { en: "Chengdu", native: "成都" },
    { en: "Hangzhou", native: "杭州" },
    { en: "Nanjing", native: "南京" },
    { en: "Xi'an", native: "西安" },
  ],
  jp: [
    { en: "Tokyo", native: "東京" },
    { en: "Osaka", native: "大阪" },
    { en: "Kyoto", native: "京都" },
    { en: "Yokohama", native: "横浜" },
    { en: "Nagoya", native: "名古屋" },
    { en: "Sapporo", native: "札幌" },
    { en: "Fukuoka", native: "福岡" },
  ],
};

// Country / region data
const countryData: Array<{ code: string; en: string; zh: string; zh_hant: string; ja: string }> = [
  { code: "US", en: "United States", zh: "美国", zh_hant: "美國", ja: "アメリカ合衆国" },
  { code: "CN", en: "China", zh: "中国", zh_hant: "中國", ja: "中国" },
  { code: "JP", en: "Japan", zh: "日本", zh_hant: "日本", ja: "日本" },
  { code: "GB", en: "United Kingdom", zh: "英国", zh_hant: "英國", ja: "イギリス" },
  { code: "DE", en: "Germany", zh: "德国", zh_hant: "德國", ja: "ドイツ" },
  { code: "FR", en: "France", zh: "法国", zh_hant: "法國", ja: "フランス" },
  { code: "CA", en: "Canada", zh: "加拿大", zh_hant: "加拿大", ja: "カナダ" },
  { code: "AU", en: "Australia", zh: "澳大利亚", zh_hant: "澳洲", ja: "オーストラリア" },
  { code: "IN", en: "India", zh: "印度", zh_hant: "印度", ja: "インド" },
  { code: "BR", en: "Brazil", zh: "巴西", zh_hant: "巴西", ja: "ブラジル" },
  { code: "RU", en: "Russia", zh: "俄罗斯", zh_hant: "俄羅斯", ja: "ロシア" },
  { code: "KR", en: "South Korea", zh: "韩国", zh_hant: "韓國", ja: "韓国" },
  { code: "IT", en: "Italy", zh: "意大利", zh_hant: "意大利", ja: "イタリア" },
  { code: "ES", en: "Spain", zh: "西班牙", zh_hant: "西班牙", ja: "スペイン" },
  { code: "MX", en: "Mexico", zh: "墨西哥", zh_hant: "墨西哥", ja: "メキシコ" },
];

// Product data
const productCategoryByLang: Record<string, string[]> = {
  en: ["Electronics", "Clothing", "Food", "Books", "Home Goods", "Sports", "Toys", "Beauty", "Furniture", "Automotive", "Garden", "Pet Supplies", "Video Games", "Music Instruments", "Office Supplies"],
  zh: ["电子", "服装", "食品", "图书", "家居", "运动", "玩具", "美妆", "家具", "汽车用品", "园艺", "宠物用品", "视频游戏", "乐器", "办公用品"],
  zh_hant: ["電子", "服裝", "食品", "圖書", "家居", "運動", "玩具", "美妝", "家具", "汽車用品", "園藝", "寵物用品", "視頻遊戲", "樂器", "辦公用品"],
  ja: ["電子機器", "衣料品", "食品", "書籍", "家財", "スポーツ", "玩具", "美容", "家具", "自動車用品", "ガーデニング", "ペット用品", "ビデオゲーム", "楽器", "オフィス用品"],
};

const colorByLang: Record<string, string[]> = {
  en: ["Red", "Blue", "Green", "Black", "White", "Yellow", "Purple", "Orange", "Pink", "Brown", "Gray", "Cyan", "Jasmine", "Teal", "Maroon", "Navy", "Olive", "Coral"],
  zh: ["红色", "蓝色", "绿色", "黑色", "白色", "黄色", "紫色", "橙色", "粉色", "棕色", "灰色", "青色", "茉莉色", "蓝绿色", "褐红色", "藏青", "橄榄", "珊瑚色"],
  zh_hant: ["紅色", "藍色", "綠色", "黑色", "白色", "黃色", "紫色", "橙色", "粉色", "棕色", "灰色", "青色", "茉莉色", "藍綠色", "褐紅色", "藏青", "橄欖", "珊瑚色"],
  ja: ["赤", "青", "緑", "黒", "白", "黄色", "紫", "オレンジ", "ピンク", "茶色", "灰色", "シアン", "ジャスミン", "ティール", "えんじ色", "ネイビー", "オリーブ", "コーラル"],
};

const sizeByLang: Record<string, string[]> = {
  en: ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "One Size"],
  zh: ["特小", "小", "中", "大", "加大", "特大", "超特大", "均码"],
  zh_hant: ["特小", "小", "中", "大", "加大", "特大", "超特大", "均碼"],
  ja: ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "フリーサイズ"],
};

function jumbleWord(word: string): string {
  const letters = word.split("");
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }
  return letters.join("");
}

function randFromCharSet(charSet: string, n: number): string {
  return Array.from({ length: n }, () => charSet.charAt(Math.floor(Math.random() * charSet.length))).join("");
}

function generateBarcode(type: string): string {
  const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10).toString()).join("");
  switch (type) {
    case "ean8":
      return digits(8);
    case "ean13":
      return digits(13);
    case "upca":
      return digits(12);
    case "upce":
      return digits(6);
    case "isbn":
      return `978${digits(10)}`;
    case "code39": {
      const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
      return `${letters}-${digits(4)}`;
    }
    default:
      return digits(13);
  }
}

function generateSkuFromPattern(pattern: string): string {
  const letterCharSet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digitCharSet = "0123456789";
  let result = "";
  const tokens = pattern.split(/([{}[\]-])/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "(" || t === ")") {
      i++;
      continue;
    }
    if (t === "[") {
      const charSetToken = tokens[i + 1];
      i += 2;
      let charSet = "";
      if (charSetToken?.includes("A-F") || charSetToken?.includes("A-Z")) {
        charSet = letterCharSet;
      } else if (charSetToken?.includes("0-9")) {
        charSet = digitCharSet;
      } else {
        charSet = letterCharSet + digitCharSet;
      }
      i++;
      let count = 1;
      if (tokens[i] === "{") {
        i++;
        count = parseInt(tokens[i], 10) || 1;
        i += 2;
      }
      result += randFromCharSet(charSet, count);
      continue;
    }
    if (t === "-") {
      result += "-";
      i++;
      continue;
    }
    i++;
  }
  if (!result) {
    return `${randFromCharSet("ABCDEF", 2)}-${randFromCharSet("ABCDEF", 2)}-${randFromCharSet("0123456789", 4)}-${randFromCharSet("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 1)}`;
  }
  return result;
}

function generateIPv6(): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) {
    groups.push(
      Math.floor(Math.random() * 65536)
        .toString(16)
        .padStart(4, "0"),
    );
  }
  return groups.join(":");
}

// Extension categories
const extensionCategoryMap: Record<string, string[]> = {
  image: [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".tiff"],
  document: [".txt", ".pdf", ".doc", ".docx", ".rtf", ".odt"],
  spreadsheet: [".xls", ".xlsx", ".csv", ".ods", ".tsv"],
  presentation: [".ppt", ".pptx", ".odp", ".key"],
  audio: [".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a"],
  video: [".mp4", ".avi", ".mov", ".mkv", ".wmv", ".flv"],
  code: [".js", ".ts", ".py", ".java", ".cpp", ".c", ".h", ".rs", ".go", ".rb", ".php"],
  archive: [".zip", ".rar", ".7z", ".tar", ".gz", ".bz2"],
  web: [".html", ".htm", ".css", ".json", ".xml", ".yml", ".yaml"],
  database: [".db", ".sqlite", ".sql", ".mdb", ".accdb"],
};

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function generateFilePath(params?: GeneratorParams): string {
  const cat = params?.extensionCategory ?? "image";
  const exts = extensionCategoryMap[cat] ?? extensionCategoryMap.image;
  const ext = pick(exts);
  const types = params?.pathTypes?.length ? params.pathTypes : ["linux"];
  const t = pick(types);
  const includeName = params?.includeFileName ?? true;
  const nameBases = ["report", "doc", "img", "photo", "backup", "config", "data", "file"];
  const randNum = randInt(1, 999999);
  const fileName = `${pick(nameBases)}_${randNum}${ext}`;
  if (t === "windows") {
    const baseDirs = ["Users", "Program Files", "ProgramData", "Windows", "Temp"];
    const userDirs = ["Administrator", "User", "Admin", "Guest"];
    const folders = ["Documents", "Downloads", "Pictures", "Music", "Videos", "Desktop"];
    const base = `C:\\${pick(baseDirs)}\\${pick(userDirs)}\\${pick(folders)}`;
    return includeName ? `${base}\\${fileName}` : base;
  }
  if (t === "macos") {
    const users = ["administrator", "user", "admin", "guest"];
    const folders = ["Documents", "Downloads", "Pictures", "Music", "Movies", "Desktop", "Library", "Applications"];
    const base = `/Users/${pick(users)}/${pick(folders)}`;
    return includeName ? `${base}/${fileName}` : base;
  }
  const baseDirs = ["home", "opt", "var", "usr", "tmp", "root"];
  const users = ["user", "admin", "root", "ubuntu", "deploy"];
  const folders = ["documents", "downloads", "pictures", "music", "videos", "projects", "data", "logs"];
  const bd = pick(baseDirs);
  const base = bd === "home" ? `/home/${pick(users)}/${pick(folders)}` : `/${bd}/${pick(folders)}`;
  return includeName ? `${base}/${fileName}` : base;
}

function generateFileName(params?: GeneratorParams): string {
  const nameBases = ["report", "photo", "backup", "config", "data", "file", "doc", "img", "project", "output", "result"];
  const base = pick(nameBases);
  const num = randInt(1, 999999);
  if (!params?.includeExtension) return `${base}_${num}`;
  const cat = params?.extensionCategory ?? "image";
  const exts = extensionCategoryMap[cat] ?? extensionCategoryMap.image;
  return `${base}_${num}${pick(exts)}`;
}

function generateFileExtension(params?: GeneratorParams): string {
  const cat = params?.extensionCategory ?? "image";
  const exts = extensionCategoryMap[cat] ?? extensionCategoryMap.image;
  return pick(exts);
}

function generateUrl(params?: GeneratorParams): string {
  const defaultSubs = ["auth.", "drive.", "image.", "www.", "api.", "mail.", "shop.", "blog."];
  const defaultTlds = [".biz", ".co.jp", ".com", ".cn", ".org", ".net", ".io", ".dev", ".xyz"];
  const baseDomains = ["example", "test", "demo", "sample", "meyer80", "acme", "contoso", "fabrikam"];
  const paths = ["ToysGames", "home", "about", "products", "login", "dashboard", "items", "search", "profile", "settings"];
  const subs = params?.urlSubdomains ? splitLines(params.urlSubdomains) : defaultSubs;
  const tlds = params?.urlTlds ? splitLines(params.urlTlds) : defaultTlds;
  const sub = subs.length ? pick(subs) : "www.";
  const tld = tlds.length ? pick(tlds) : ".com";
  return `https://${sub}${pick(baseDomains)}${tld}/${pick(paths)}`;
}

function generateHostname(params?: GeneratorParams): string {
  const defaultSubs = ["auth.", "drive.", "image.", "www.", "api.", "mail.", "shop.", "blog."];
  const defaultTlds = [".biz", ".co.jp", ".com", ".cn", ".org", ".net", ".io", ".dev", ".xyz"];
  const baseDomains = ["example", "test", "demo", "sample", "meyer80", "acme", "contoso", "fabrikam"];
  const subs = params?.urlSubdomains ? splitLines(params.urlSubdomains) : defaultSubs;
  const tlds = params?.urlTlds ? splitLines(params.urlTlds) : defaultTlds;
  const sub = subs.length ? pick(subs) : "www.";
  const tld = tlds.length ? pick(tlds) : ".com";
  return `${sub}${pick(baseDomains)}${tld}`;
}

function transformText(text: string, mode: string): string {
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  if (mode === "title") return text.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  return text;
}

function generateEmail(): string {
  return `${pick(firstNames).toLowerCase()}.${pick(lastNames).toLowerCase()}@${pick(domains)}`;
}
function generatePhone(): string {
  return `+1${randInt(200, 999)}${randInt(100, 999)}${randInt(1000, 9999)}`;
}
function generateIP(): string {
  return `${randInt(1, 255)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 255)}`;
}
function generateMAC(): string {
  return Array.from({ length: 6 }, () => randInt(0, 255).toString(16).padStart(2, "0").toUpperCase()).join(":");
}

function pickLang(languages: string[] | undefined, fallback: string): string {
  if (languages && languages.length) return pick(languages);
  return fallback;
}

function formatFullName(first: string, last: string, lang: string): string {
  const cjkNative = new Set(["zh_hans", "zh_hant", "ja"]);
  const cjkRomanized = new Set(["zh_pinyin", "ja_romaji"]);
  if (cjkNative.has(lang)) return `${last}${first}`;
  if (cjkRomanized.has(lang)) return `${last} ${first}`;
  return `${first} ${last}`;
}

const GeneratorFunctions: Record<string, (params?: GeneratorParams) => string> = {
  full_name: (params) => {
    const lang = params?.languages?.[0] ?? "en";
    const fnMap: Record<string, string[]> = {
      en: firstNames,
      zh_hans: ["伟", "芳", "娜", "秀英", "敏", "静", "丽", "强", "磊", "洋"],
      zh_hant: ["偉", "芳", "娜", "秀英", "敏", "靜", "麗", "強", "磊", "洋"],
      ja: ["翼", "桜", "翔太", "美咲", "蓮", "結菜", "大輔", "陽子"],
    };
    const lnMap: Record<string, string[]> = {
      en: lastNames,
      zh_hans: ["王", "李", "张", "刘", "陈", "杨", "赵", "黄"],
      zh_hant: ["王", "李", "張", "劉", "陳", "楊", "趙", "黃"],
      ja: ["佐藤", "鈴木", "高橋", "田中", "渡辺"],
    };
    const fn = pick(fnMap[lang] ?? firstNames);
    const ln = pick(lnMap[lang] ?? lastNames);
    const fmt = params?.nameFormat ?? "full";
    if (fmt === "first") return fn;
    if (fmt === "last") return ln;
    return formatFullName(fn, ln, lang);
  },
  email: generateEmail,
  phone: generatePhone,
  gender: (params) => {
    const lang = params?.languages?.[0] ?? "en";
    const map: Record<string, string[]> = {
      en: ["Male", "Female"],
      zh: ["男", "女"],
      zh_hant: ["男", "女"],
      ja: ["男性", "女性"],
    };
    return pick(map[lang] ?? map["en"]);
  },
  title: () => pick(["Mr.", "Ms.", "Dr.", "Prof."]),
  marital_status: (params) => {
    const lang = params?.languages?.[0] ?? "en";
    const map: Record<string, string[]> = {
      en: ["Single", "Married", "Divorced", "Widowed"],
      zh: ["未婚", "已婚", "离异", "丧偶"],
      zh_hant: ["未婚", "已婚", "離異", "喪偶"],
      ja: ["未婚", "既婚", "離婚", "死別"],
    };
    return pick(map[lang] ?? map["en"]);
  },
  job_title: (params) => {
    const lang = params?.languages?.[0] ?? "en";
    const map: Record<string, string[]> = {
      en: ["Software Engineer", "Senior Manager", "Product Designer", "Data Analyst", "DevOps Engineer", "HR Director", "Marketing Lead"],
      zh: ["软件工程师", "高级经理", "产品设计师", "数据分析师", "运维工程师"],
      zh_hant: ["軟體工程師", "高級經理", "產品設計師"],
      ja: ["ソフトウェアエンジニア", "シニアマネージャー", "プロダクトデザイナー"],
    };
    return pick(map[lang] ?? map["en"]);
  },
  social_id: () => `SN${randInt(100000, 999999)}`,
  payment_method: (params) => {
    const vals = (params?.values ?? "Credit Card\nPayPal\nApple Pay\nGoogle Pay\nBank Transfer\nCash\nCryptocurrency")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return vals.length ? pick(vals) : "Credit Card";
  },
  credit_card_type: (params) => {
    const selected = params?.cardTypes?.length ? params.cardTypes : Object.keys(ccLabelMap);
    const key = pick(selected);
    return ccLabelMap[key] ?? "Visa";
  },
  credit_card_number: (params) => {
    const selected = params?.cardTypes?.length ? params.cardTypes : ["visa"];
    const key = pick(selected);
    const prefix = pick(ccPrefixMap[key] ?? ccPrefixMap["visa"]);
    const length = ccLengthMap[key] ?? 16;
    return generateLuhnCard(prefix, length);
  },
  credit_card_date: (params) => {
    const fmt = params?.ccDateFormat ?? "MM/YY";
    const now = new Date();
    const yearBase = now.getFullYear() + randInt(params?.ccYearOffsetMin ?? 0, params?.ccYearOffsetMax ?? 5);
    const month = randInt(1, 12);
    switch (fmt) {
      case "MM/YYYY":
        return `${pad2(month)}/${yearBase}`;
      case "YYYY-MM":
        return `${yearBase}-${pad2(month)}`;
      case "MM/YY":
      default:
        return `${pad2(month)}/${pad2(yearBase % 100)}`;
    }
  },
  company_name: (params) => generateCompanyName(pickLang(params?.languages, "en")),
  department: (params) => pick(departmentByLang[pickLang(params?.languages, "en")] ?? departmentByLang["en"]),
  industry: (params) => pick(industryByLang[pickLang(params?.languages, "en")] ?? industryByLang["en"]),
  address: (params) => {
    const regions = params?.regions?.length ? params.regions : ["us"];
    const region = pick(regions);
    return generateAddress(params?.addressType ?? "line1", region);
  },
  city: (params) => {
    const regions = params?.regions?.length ? params.regions : ["us"];
    const region = pick(regions);
    const city = pick(cityData[region] ?? cityData["us"]);
    const lang = params?.languages?.[0] ?? "en";
    return lang === "native" ? city.native : city.en;
  },
  region: (params) => {
    const country = pick(countryData);
    const lang = params?.regionLang ?? "en";
    const fmt = params?.regionFormat ?? "name";
    const tf = params?.textTransform ?? "none";
    let text = "";
    if (fmt === "code") text = country.code;
    else if (fmt === "code_name") text = `${country.code} - ${(country as any)[lang] ?? country.en}`;
    else text = (country as any)[lang] ?? country.en;
    return transformText(text, tf);
  },
  product_name: (params) => {
    const keywords = (params?.productKeywords ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (keywords.length === 0) return `${pick(["Premium", "Basic", "Ultra", "Standard"])} ${pick(["Widget", "Gadget", "Tool", "Device"])}`;
    const mode = Math.random();
    if (mode < 0.4) return pick(keywords);
    if (mode < 0.7) return `${pick(keywords)} ${pick(keywords)}`;
    return jumbleWord(pick(keywords).toLowerCase());
  },
  product_category: (params) => pick(productCategoryByLang[pickLang(params?.languages, "en")] ?? productCategoryByLang["en"]),
  color: (params) => pick(colorByLang[pickLang(params?.languages, "en")] ?? colorByLang["en"]),
  size: (params) => pick(sizeByLang[pickLang(params?.languages, "en")] ?? sizeByLang["en"]),
  weight_unit: (params) => {
    const vals = (params?.values ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    return vals.length ? pick(vals) : pick(["kg", "g", "lb", "oz"]);
  },
  barcode: (params) => {
    const selected = params?.barcodeTypes?.length ? params.barcodeTypes : ["ean13"];
    return generateBarcode(pick(selected));
  },
  sku: (params) => generateSkuFromPattern(params?.pattern ?? "([A-F]{2}[-]){2}([0-9]{4}[-])([A-Z])"),
  ip_address: (params) => (params?.ipType === "ipv6" ? generateIPv6() : generateIP()),
  mac_address: generateMAC,
  file_path: (params) => generateFilePath(params),
  file_name: (params) => generateFileName(params),
  file_extension: (params) => generateFileExtension(params),
  url: (params) => generateUrl(params),
  hostname: (params) => generateHostname(params),
};

const KnownColumnPatterns: Array<{ pattern: RegExp; generatorKey: string }> = [
  { pattern: /email|e-?mail|mail/i, generatorKey: "email" },
  { pattern: /phone|tel|mobile|cell|fax/i, generatorKey: "phone" },
  { pattern: /first.?name|fname|given.?name/i, generatorKey: "full_name" },
  { pattern: /last.?name|lname|surname|family.?name/i, generatorKey: "full_name" },
  { pattern: /full.?name|name|user.?name/i, generatorKey: "full_name" },
  { pattern: /gender|sex/i, generatorKey: "gender" },
  { pattern: /city/i, generatorKey: "city" },
  { pattern: /country/i, generatorKey: "city" },
  { pattern: /zip|postal.?code|postcode/i, generatorKey: "number" },
  { pattern: /address|street/i, generatorKey: "address" },
  { pattern: /url|website|link/i, generatorKey: "url" },
  { pattern: /ip/i, generatorKey: "ip_address" },
  { pattern: /mac/i, generatorKey: "mac_address" },
  { pattern: /uuid|guid/i, generatorKey: "uuid" },
  { pattern: /company|corp|organization|org/i, generatorKey: "company_name" },
  { pattern: /department|dept/i, generatorKey: "department" },
  { pattern: /color|colour/i, generatorKey: "color" },
  { pattern: /title|position/i, generatorKey: "job_title" },
  { pattern: /description|comment|note|summary|bio|content/i, generatorKey: "text" },
  { pattern: /status|state/i, generatorKey: "enum" },
  { pattern: /barcode|upc|ean/i, generatorKey: "barcode" },
  { pattern: /sku/i, generatorKey: "sku" },
];

export function findGeneratorKey(columnName: string, dataType: string): string {
  for (const { pattern, generatorKey } of KnownColumnPatterns) {
    if (pattern.test(columnName)) return generatorKey;
  }
  const type = dataType.toLowerCase();
  if (type.includes("int") || type.includes("serial") || type === "bigint" || type === "smallint") return "number";
  if (type.includes("bool")) return "number";
  if (type.includes("decimal") || type.includes("numeric") || type.includes("float") || type.includes("double") || type === "real") return "number";
  if (type.includes("date") || type.includes("timestamp")) return "datetime";
  if (type === "time") return "time";
  if (type.includes("char") || type.includes("text") || type.includes("varchar") || type === "clob") return "text";
  if (type.includes("uuid") || type.includes("guid")) return "uuid";
  return "text";
}

export function getGeneratorCategoryAndLabel(key: string): { category: string; categoryLabel: string; label: string } {
  const genKey = key.startsWith("general/") ? key.slice(8) : key;
  for (const cat of GeneratorHierarchy) {
    const child = cat.children?.find((c) => c.key === genKey);
    if (child) return { category: cat.key, categoryLabel: cat.label, label: child.label };
  }
  return { category: "general", categoryLabel: "通用", label: key };
}

export function generateValue(columnName: string, dataType: string, generatorKey: string | undefined, rowIndex: number, params?: GeneratorParams): unknown {
  // null / default overrides
  if (params?.includeNull && params.nullPercent && Math.random() * 100 < params.nullPercent) return null;
  if (params?.includeDefault && params.defaultPercent && Math.random() * 100 < params.defaultPercent) return null;

  const key = generatorKey ?? findGeneratorKey(columnName, dataType);
  if ((key === "date" || key === "datetime") && rowIndex === 0) {
    console.log("[dbx:gen] col=%s key=%s start=%j end=%j allDay=%j", columnName, key, params?.start, params?.end, params?.allDay);
  }

  if (key === "number") {
    const min = params?.min ?? 1;
    const max = params?.max ?? 1000;
    if (params?.numberType === "decimal") {
      return randDecimal(min, max, params.decimalPlaces ?? 2);
    }
    return randInt(min, max);
  }
  if (key === "sequence") {
    const start = params?.startValue ?? 1;
    const inc = params?.increment ?? 1;
    let val = start + rowIndex * inc;
    if (params?.sequenceMin !== undefined && params?.sequenceMax !== undefined && params?.sequenceCycle) {
      const range = params.sequenceMax - params.sequenceMin + 1;
      val = params.sequenceMin + ((((val - params.sequenceMin) % range) + range) % range);
    } else if (params?.sequenceMin !== undefined && val < params.sequenceMin) {
      val = params.sequenceMin;
    } else if (params?.sequenceMax !== undefined && val > params.sequenceMax) {
      val = params.sequenceMax;
    }
    return val;
  }
  if (key === "datetime") {
    const start = params?.start ? parseLocalDate(params.start) : new Date("2020-01-01");
    const end = params?.end ? parseLocalDate(params.end) : new Date();
    if (params?.allDay) {
      const [rangeStart, rangeEnd] = ensureRange(start, end);
      const d = new Date(rangeStart.getTime() + Math.random() * (rangeEnd.getTime() - rangeStart.getTime()));
      const sh = parseInt(params.startTime ?? "00") || 0;
      const sm = parseInt(params.endTime ?? "23") || 23;
      const h = Math.floor(Math.random() * (sm - sh + 1)) + sh;
      const m = Math.floor(Math.random() * 60);
      const s = Math.floor(Math.random() * 60);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${formatLocalDate(d)} ${pad(h)}:${pad(m)}:${pad(s)}`;
    }
    return randTimestamp(start, end);
  }
  if (key === "date") {
    const start = params?.start ? parseLocalDate(params.start) : new Date("2020-01-01");
    const end = params?.end ? parseLocalDate(params.end) : new Date();
    return randDate(start, end);
  }
  if (key === "time") {
    let sh = 0,
      sm = 23;
    if (!params?.allDay) {
      sh = parseInt(params?.startTime ?? "00") || 0;
      sm = parseInt(params?.endTime ?? "23") || 23;
    }
    const h = Math.floor(Math.random() * (sm - sh + 1)) + sh;
    const m = Math.floor(Math.random() * 60);
    const s = Math.floor(Math.random() * 60);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  if (key === "enum") {
    const vals = (params?.values ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (vals.length === 0) return pick(["A", "B", "C", "D", "E"]);
    return vals[Math.floor(Math.random() * vals.length)];
  }
  if (key === "text") {
    const texts = [
      "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat",
      "The quick brown fox jumps over the lazy dog near the bank of the river A gentle breeze carried the scent of wildflowers across the meadow as birds sang melodies from the treetops",
      "In the world of technology change is the only constant Innovations emerge daily reshaping how we live work and communicate with one another across vast distances",
      "科学研究需要坚持不懈的努力和严谨的态度每一个实验每一次观察都是通向真理的重要一步不断积累的知识终将改变世界",
      "数据库管理系统是现代应用的核心支柱从简单的数据存储到复杂的高并发查询它支撑着数以亿计的用户请求",
    ];
    const minLen = params?.minLength ?? 50;
    const maxLen = params?.maxLength ?? 500;
    const len = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen;
    const base = texts[Math.floor(Math.random() * texts.length)];
    if (base.length >= len) return base.slice(0, len);
    const repeats = Math.ceil(len / base.length) + 1;
    const txt = Array.from({ length: repeats }, () => base).join(" ");
    return txt.slice(0, len);
  }
  if (key === "uuid") {
    const hex = "0123456789abcdef";
    const parts = [8, 4, 4, 4, 12];
    const uuid = parts.map((length) => Array.from({ length }, () => hex[Math.floor(Math.random() * 16)]).join(""));
    return params?.uuidHyphens !== false ? uuid.join("-") : uuid.join("");
  }
  if (key === "foreign_key") {
    return randInt(params?.min ?? 1, params?.max ?? 500);
  }
  if (key === "image") return `0x${Array.from({ length: 16 }, () => randInt(0, 255).toString(16).padStart(2, "0")).join("")}`;

  const fn = GeneratorFunctions[key];
  if (fn) return fn(params);

  return generateByType(dataType, rowIndex);
}

function generateByType(type: string, rowIndex: number): unknown {
  const t = type.toLowerCase();
  if (t.includes("int") || t.includes("serial") || t === "bigint" || t === "smallint" || t === "tinyint") return randInt(1, 1000);
  if (t.includes("decimal") || t.includes("numeric") || t.includes("float") || t.includes("double") || t === "real") return randDecimal(0, 10000, 2);
  if (t.includes("bool")) return Math.random() > 0.5 ? 1 : 0;
  if (t.includes("date")) return randDate(new Date("2020-01-01"), new Date("2025-12-31"));
  if (t.includes("time")) return randTimestamp(new Date("2020-01-01"), new Date("2025-12-31"));
  return `value_${rowIndex + 1}`;
}

export function formatGeneratedValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

export interface GenerateResult {
  columns: string[];
  rows: unknown[][];
  sql: string;
}

export function generateTableData(config: TableGenerateConfig, databaseType?: DatabaseType): GenerateResult {
  const colNames = config.columns.map((c) => c.columnName);
  const rows: unknown[][] = [];

  for (let i = 0; i < config.rowCount; i++) {
    const row = config.columns.map((col) => generateValue(col.columnName, col.dataType, col.generatorKey, i, col.generatorParams));
    rows.push(row);
  }

  const valuesSql = rows.map((row) => `(${row.map(formatGeneratedValue).join(", ")})`).join(",\n");

  const quotedCols = config.columns.map((c) => quoteTableIdentifier(databaseType, c.columnName));
  const sql = `INSERT INTO ${quoteTableIdentifier(databaseType, config.tableName)} (${quotedCols.join(", ")}) VALUES\n${valuesSql};`;

  return { columns: colNames, rows, sql };
}
