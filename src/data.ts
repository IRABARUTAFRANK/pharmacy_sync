// ─── Pharmacy Sync — Central Data & Types ─────────────────────────────────────

export type Role = 'owner' | 'manager' | 'pharmacist' | 'seller'

// ─── Barcode Types ────────────────────────────────────────────────────────────

export interface BarcodeSession {
  id: string              // Session ID e.g. "BS-2026-0042"
  createdAt: string
  product: {
    name: string
    category: string
    expiry: string        // YYYY-MM
    unitPrice: number
    batch: string
    supplier: string
    reorderPoint: number
    prescription: boolean
    notes: string
  }
  quantity: number         // Total pieces in this batch
  piecesBarcodes: PieceBarcode[]  // One per piece
  bulkBarcode: string      // The master barcode for all pieces
  addedToStock: boolean
  stockAddedAt?: string
}

export interface PieceBarcode {
  code: string             // Unique barcode e.g. "PS-ANT-202608-001"
  pieceNumber: number      // 1..N
  status: 'generated' | 'printed' | 'in_stock' | 'sold'
}

export interface ScanEvent {
  id: string
  timestamp: string
  barcode: string
  resolvedType: 'bulk_stock' | 'piece_stock' | 'sale' | 'unknown'
  productName?: string
  quantity?: number
  message: string
  success: boolean
}

// ─── Barcode Helpers ──────────────────────────────────────────────────────────

const CAT_CODE: Record<string, string> = {
  'Antibiotics': 'ANT', 'Analgesics': 'ANG', 'Vitamins': 'VIT',
  'Antidiabetics': 'ADB', 'Cardiovascular': 'CRD', 'Respiratory': 'RSP',
  'Dermatology': 'DRM', 'Gastrointestinal': 'GST', 'Other': 'OTH',
}

export function categoryCode(cat: string): string {
  return CAT_CODE[cat] ?? 'OTH'
}

export function generatePieceBarcode(
  sessionId: string, catCode: string, yyyymm: string, pieceNum: number
): string {
  const idx = String(pieceNum).padStart(3, '0')
  return `PS${catCode}${yyyymm.replace('-', '')}${sessionId.slice(-4)}${idx}`
}

export function generateBulkBarcode(sessionId: string, qty: number): string {
  return `PSBULK${sessionId.slice(-6)}${String(qty).padStart(3, '0')}`
}

// ─── Seed Barcode Registry ────────────────────────────────────────────────────

export const barcodeSessions: BarcodeSession[] = [
  {
    id: 'BS-2026-0038',
    createdAt: '2026-08-10 09:14',
    product: {
      name: 'Amoxicillin 500mg',
      category: 'Antibiotics',
      expiry: '2027-08',
      unitPrice: 1500,
      batch: 'BT-2026-441',
      supplier: 'MedPharm Supplies',
      reorderPoint: 200,
      prescription: false,
      notes: 'Store below 25°C',
    },
    quantity: 40,
    piecesBarcodes: Array.from({ length: 40 }, (_, i) => ({
      code: `PSANT20260838${String(i + 1).padStart(3, '0')}`,
      pieceNumber: i + 1,
      status: i < 6 ? 'sold' : 'in_stock',
    })),
    bulkBarcode: 'PSBULK003840040',
    addedToStock: true,
    stockAddedAt: '2026-08-10 09:42',
  },
  {
    id: 'BS-2026-0039',
    createdAt: '2026-08-12 14:22',
    product: {
      name: 'Metformin 850mg',
      category: 'Antidiabetics',
      expiry: '2027-06',
      unitPrice: 1200,
      batch: 'BT-2026-289',
      supplier: 'Rwanda Pharma Ltd',
      reorderPoint: 150,
      prescription: true,
      notes: 'Prescription required — diabetes management',
    },
    quantity: 60,
    piecesBarcodes: Array.from({ length: 60 }, (_, i) => ({
      code: `PSADB20260839${String(i + 1).padStart(3, '0')}`,
      pieceNumber: i + 1,
      status: i < 12 ? 'sold' : 'in_stock',
    })),
    bulkBarcode: 'PSBULK003960060',
    addedToStock: true,
    stockAddedAt: '2026-08-12 14:55',
  },
]

export const scanHistory: ScanEvent[] = [
  { id: 'SC-001', timestamp: '2026-08-15 14:22', barcode: 'PSANT20260838012', resolvedType: 'sale', productName: 'Amoxicillin 500mg', quantity: 1, message: 'Product found — added to sale cart', success: true },
  { id: 'SC-002', timestamp: '2026-08-15 14:08', barcode: 'PSBULK003840040', resolvedType: 'bulk_stock', productName: 'Amoxicillin 500mg', quantity: 40, message: 'Bulk barcode — 40 units added to inventory', success: true },
  { id: 'SC-003', timestamp: '2026-08-15 13:50', barcode: 'PSADB20260839004', resolvedType: 'sale', productName: 'Metformin 850mg', quantity: 1, message: 'Product found — added to sale cart', success: true },
  { id: 'SC-004', timestamp: '2026-08-15 11:30', barcode: 'UNKNOWN99123456', resolvedType: 'unknown', message: 'Barcode not recognised — register new product?', success: false },
]

export type AlertSeverity = 'critical' | 'warning' | 'info'

export interface NavItem {
  id: string
  label: string
  icon: string
  badge?: number
  roles: Role[]
}

export interface KPIData {
  id: string
  label: string
  value: string
  rawValue: number
  change: number
  sub: string
  icon: string
  color: string
  sparkline: number[]
  unit: string
}

export interface ProductItem {
  id: string
  name: string
  category: string
  batch: string
  expiry: string
  stock: number
  reorder: number
  unitPrice: number
  status: 'ok' | 'low' | 'zero' | 'expiry'
  supplier: string
}

export interface Transaction {
  id: string
  date: string
  patient: string
  pharmacist: string
  items: TransactionItem[]
  total: number
  payment: 'Cash' | 'Mobile Money' | 'Insurance' | 'Card'
  receipt: string
  status: 'paid' | 'pending' | 'refunded'
  insurance?: string
  branch: string
}

export interface TransactionItem {
  productId: string
  name: string
  qty: number
  unitPrice: number
  total: number
}

export interface AlertItem {
  id: number
  type: AlertSeverity
  title: string
  msg: string
  time: string
  branch: string
  dismissed: boolean
}

export interface InsuranceProvider {
  id: string
  name: string
  coverage: number
  claims: number
  covered: number
  pending: number
  active: boolean
}

// ─── Nav Config ───────────────────────────────────────────────────────────────

// Two functional tiers from here on: owner/manager see everything, seller
// sees only Sales, Patients, and Help -- "for confidentiality of
// information," per the request that shaped this list. `pharmacist`/`staff`
// stay legal role values in the database (nothing ever created one) but no
// nav item grants them anything any more; the only roles a real login can
// ever end up with going forward are owner, manager, and seller.
export const NAV_ITEMS: NavItem[] = [
  // ── Owner / manager only ────────────────────────────────────
  { id: 'overview',     label: 'Overview',            icon: '◉',  roles: ['owner', 'manager'] },
  { id: 'inventory',   label: 'Inventory Dashboard',  icon: '📦', roles: ['owner', 'manager'] },
  { id: 'receiving',   label: 'Receive Stock',        icon: '📥', roles: ['owner', 'manager'] },
  { id: 'requestProduct', label: 'Request Product',   icon: '🙋', roles: ['owner', 'manager'] },
  { id: 'barcode',     label: 'Barcode Manager',      icon: '▦',  roles: ['owner', 'manager'] },
  { id: 'reports',     label: 'Products in Stock',    icon: '📦', roles: ['owner', 'manager'] },
  { id: 'alerts',      label: 'Alerts',               icon: '🔔', roles: ['owner', 'manager'] },
  { id: 'transactions',label: 'Transactions',         icon: '💳', roles: ['owner', 'manager'] },
  { id: 'insurance',   label: 'Insurance',            icon: '🏥', roles: ['owner', 'manager'] },
  { id: 'team',        label: 'Team',                 icon: '👥', roles: ['owner', 'manager'] },
  // ── Shared with seller ──────────────────────────────────────
  { id: 'sales',       label: 'Sales / POS',          icon: '🧾', roles: ['owner', 'manager', 'seller'] },
  { id: 'patients',    label: 'Patients',              icon: '🩺', roles: ['owner', 'manager', 'seller'] },
  { id: 'help',        label: 'Help & Support',       icon: '💬', roles: ['owner', 'manager', 'seller'] },
  // ── Owner only ───────────────────────────────────────────────
  { id: 'branch',      label: 'Branch Settings',      icon: '⚙️', roles: ['owner'] },
  { id: 'history',     label: 'History',              icon: '🕓', roles: ['owner'] },
]

// ─── KPIs ─────────────────────────────────────────────────────────────────────

export const KPIS: KPIData[] = [
  {
    id: 'revenue', label: 'Total Revenue', value: 'RWF 6.40M', rawValue: 6400000,
    change: 10.3, sub: 'vs last month', icon: '💰', color: '#1e5fa8', unit: 'RWF',
    sparkline: [4200000, 3800000, 5100000, 4700000, 5600000, 6100000, 5800000, 6400000],
  },
  {
    id: 'profit', label: 'Net Profit', value: 'RWF 1.75M', rawValue: 1750000,
    change: 17.4, sub: 'vs last month', icon: '📈', color: '#3b82f6', unit: 'RWF',
    sparkline: [980000, 820000, 1240000, 1100000, 1380000, 1620000, 1490000, 1750000],
  },
  {
    id: 'transactions', label: 'Transactions', value: '1,214', rawValue: 1214,
    change: 5.8, sub: 'this month', icon: '🧾', color: '#0284c7', unit: 'count',
    sparkline: [980, 860, 1120, 1040, 1180, 1310, 1160, 1214],
  },
  {
    id: 'inventory', label: 'Inventory Value', value: 'RWF 48.2M', rawValue: 48200000,
    change: -2.1, sub: 'vs last month', icon: '📦', color: '#d97706', unit: 'RWF',
    sparkline: [51000000, 50200000, 49800000, 49200000, 48900000, 48600000, 48400000, 48200000],
  },
  {
    id: 'patients', label: 'Active Patients', value: '3,841', rawValue: 3841,
    change: 8.2, sub: 'registered', icon: '👤', color: '#7c3aed', unit: 'count',
    sparkline: [3200, 3320, 3450, 3560, 3620, 3700, 3780, 3841],
  },
  {
    id: 'growth', label: 'Revenue Growth', value: '+10.3%', rawValue: 10.3,
    change: 2.4, sub: 'MoM improvement', icon: '🚀', color: '#1e5fa8', unit: '%',
    sparkline: [6.2, 7.1, 8.4, 7.8, 9.1, 8.9, 9.7, 10.3],
  },
]

// ─── Revenue Trend ────────────────────────────────────────────────────────────

export const revenueData = [
  { month: 'Jan', revenue: 4200000, profit: 980000, target: 4000000, expenses: 3220000 },
  { month: 'Feb', revenue: 3800000, profit: 820000, target: 4000000, expenses: 2980000 },
  { month: 'Mar', revenue: 5100000, profit: 1240000, target: 4500000, expenses: 3860000 },
  { month: 'Apr', revenue: 4700000, profit: 1100000, target: 4500000, expenses: 3600000 },
  { month: 'May', revenue: 5600000, profit: 1380000, target: 5000000, expenses: 4220000 },
  { month: 'Jun', revenue: 6100000, profit: 1620000, target: 5000000, expenses: 4480000 },
  { month: 'Jul', revenue: 5800000, profit: 1490000, target: 5500000, expenses: 4310000 },
  { month: 'Aug', revenue: 6400000, profit: 1750000, target: 5500000, expenses: 4650000 },
]

// ─── Category Sales ───────────────────────────────────────────────────────────

export const categoryData = [
  { name: 'Antibiotics',      sales: 1840000, units: 2840, margin: 28 },
  { name: 'Analgesics',       sales: 1320000, units: 4200, margin: 22 },
  { name: 'Vitamins',         sales: 980000,  units: 6100, margin: 35 },
  { name: 'Antidiabetics',    sales: 1560000, units: 1940, margin: 31 },
  { name: 'Cardiovascular',   sales: 1120000, units: 1340, margin: 29 },
  { name: 'Respiratory',      sales: 740000,  units: 2200, margin: 24 },
  { name: 'Dermatology',      sales: 560000,  units: 1800, margin: 33 },
]

// ─── Daily Sales ──────────────────────────────────────────────────────────────

export const dailySales = [
  { day: 'Mon', txn: 142, amount: 890000,  cash: 374000,  momo: 276000,  insurance: 178000,  card: 62000 },
  { day: 'Tue', txn: 168, amount: 1040000, cash: 437000,  momo: 322000,  insurance: 208000,  card: 73000 },
  { day: 'Wed', txn: 195, amount: 1280000, cash: 538000,  momo: 397000,  insurance: 256000,  card: 89000 },
  { day: 'Thu', txn: 158, amount: 980000,  cash: 412000,  momo: 304000,  insurance: 196000,  card: 68000 },
  { day: 'Fri', txn: 214, amount: 1460000, cash: 613000,  momo: 453000,  insurance: 292000,  card: 102000 },
  { day: 'Sat', txn: 237, amount: 1620000, cash: 681000,  momo: 502000,  insurance: 324000,  card: 113000 },
  { day: 'Sun', txn: 98,  amount: 620000,  cash: 260000,  momo: 192000,  insurance: 124000,  card: 44000 },
]

export const paymentMethodData = [
  { name: 'Cash',         value: 42, color: '#1e5fa8' },
  { name: 'Mobile Money', value: 31, color: '#60a5fa' },
  { name: 'Insurance',    value: 18, color: '#3b82f6' },
  { name: 'Card',         value: 9,  color: '#a7f3d0' },
]

// ─── Top Products ─────────────────────────────────────────────────────────────

export const topProducts = [
  { rank: 1,  id: 'P001', name: 'Amoxicillin 500mg',   category: 'Antibiotics',    sold: 842,  revenue: 1263000, stock: 1240, trend: 12.4,  branch: 'Kigali HQ' },
  { rank: 2,  id: 'P002', name: 'Metformin 850mg',     category: 'Antidiabetics',  sold: 718,  revenue: 1077000, stock: 890,  trend: 8.1,   branch: 'Kigali HQ' },
  { rank: 3,  id: 'P003', name: 'Paracetamol 500mg',   category: 'Analgesics',     sold: 1402, revenue: 842000,  stock: 3200, trend: 3.2,   branch: 'Musanze' },
  { rank: 4,  id: 'P004', name: 'Atorvastatin 20mg',   category: 'Cardiovascular', sold: 523,  revenue: 836800,  stock: 640,  trend: 5.9,   branch: 'Kigali HQ' },
  { rank: 5,  id: 'P005', name: 'Amlodipine 5mg',      category: 'Cardiovascular', sold: 489,  revenue: 782400,  stock: 720,  trend: -2.1,  branch: 'Butare' },
  { rank: 6,  id: 'P006', name: 'Vitamin D3 1000IU',   category: 'Vitamins',       sold: 1034, revenue: 620400,  stock: 2100, trend: 18.7,  branch: 'Gisenyi' },
  { rank: 7,  id: 'P007', name: 'Ciprofloxacin 500mg', category: 'Antibiotics',    sold: 398,  revenue: 596800,  stock: 480,  trend: -5.3,  branch: 'Musanze' },
  { rank: 8,  id: 'P008', name: 'Omeprazole 20mg',     category: 'Gastrointestinal', sold: 612, revenue: 550800, stock: 960, trend: 7.2,   branch: 'Kigali HQ' },
]

// ─── Inventory ────────────────────────────────────────────────────────────────

export const inventoryItems: ProductItem[] = [
  { id: 'P001', name: 'Amoxicillin 500mg',    category: 'Antibiotics',    batch: 'BT-2024-441', expiry: '2026-08', stock: 1240, reorder: 200, unitPrice: 1500, status: 'ok',     supplier: 'MedPharm Supplies' },
  { id: 'P002', name: 'Metformin 850mg',      category: 'Antidiabetics',  batch: 'BT-2024-289', expiry: '2027-03', stock: 890,  reorder: 150, unitPrice: 1200, status: 'ok',     supplier: 'Rwanda Pharma Ltd' },
  { id: 'P003', name: 'Paracetamol 500mg',    category: 'Analgesics',     batch: 'BT-2024-512', expiry: '2025-12', stock: 3200, reorder: 500, unitPrice: 600,  status: 'ok',     supplier: 'HealthPlus RW' },
  { id: 'P004', name: 'Ciprofloxacin 250mg',  category: 'Antibiotics',    batch: 'BT-2024-098', expiry: '2026-06', stock: 0,    reorder: 100, unitPrice: 2200, status: 'zero',   supplier: 'MedPharm Supplies' },
  { id: 'P005', name: 'Insulin Glargine',     category: 'Antidiabetics',  batch: 'BT-2024-771', expiry: '2024-10', stock: 47,   reorder: 50,  unitPrice: 8400, status: 'expiry', supplier: 'BioMed Africa' },
  { id: 'P006', name: 'Metformin 500mg',      category: 'Antidiabetics',  batch: 'BT-2024-304', expiry: '2026-09', stock: 23,   reorder: 150, unitPrice: 1000, status: 'low',    supplier: 'Rwanda Pharma Ltd' },
  { id: 'P007', name: 'Atorvastatin 20mg',    category: 'Cardiovascular', batch: 'BT-2024-556', expiry: '2027-01', stock: 640,  reorder: 100, unitPrice: 1600, status: 'ok',     supplier: 'CardioMed Ltd' },
  { id: 'P008', name: 'Amlodipine 5mg',       category: 'Cardiovascular', batch: 'BT-2024-612', expiry: '2026-11', stock: 720,  reorder: 120, unitPrice: 1400, status: 'ok',     supplier: 'CardioMed Ltd' },
  { id: 'P009', name: 'Vitamin D3 1000IU',    category: 'Vitamins',       batch: 'BT-2024-881', expiry: '2027-06', stock: 2100, reorder: 300, unitPrice: 600,  status: 'ok',     supplier: 'NutriHealth RW' },
  { id: 'P010', name: 'Omeprazole 20mg',      category: 'Gastrointestinal', batch: 'BT-2024-334', expiry: '2026-04', stock: 960, reorder: 180, unitPrice: 900, status: 'ok',    supplier: 'HealthPlus RW' },
  { id: 'P011', name: 'Salbutamol 100mcg',    category: 'Respiratory',    batch: 'BT-2024-203', expiry: '2026-02', stock: 85,   reorder: 100, unitPrice: 3600, status: 'low',    supplier: 'RespiCare Ltd' },
  { id: 'P012', name: 'Hydrocortisone 1%',    category: 'Dermatology',    batch: 'BT-2024-719', expiry: '2026-10', stock: 340,  reorder: 80,  unitPrice: 2100, status: 'ok',     supplier: 'DermaPharm RW' },
]

// ─── Transactions ─────────────────────────────────────────────────────────────

export const transactions: Transaction[] = [
  {
    id: 'TXN-8841', date: '2026-08-15 14:22', patient: 'Jean Baptiste M.', pharmacist: 'Alice K.',
    items: [{ productId: 'P001', name: 'Amoxicillin 500mg', qty: 3, unitPrice: 1500, total: 4500 }, { productId: 'P009', name: 'Vitamin D3 1000IU', qty: 2, unitPrice: 600, total: 1200 }, { productId: 'P010', name: 'Omeprazole 20mg', qty: 3, unitPrice: 900, total: 2700 }],
    total: 8400, payment: 'Cash', receipt: 'E-Receipt', status: 'paid', branch: 'Kigali HQ'
  },
  {
    id: 'TXN-8840', date: '2026-08-15 14:08', patient: 'Uwimana Claire', pharmacist: 'Bob M.',
    items: [{ productId: 'P004', name: 'Ciprofloxacin 250mg', qty: 1, unitPrice: 2200, total: 2200 }],
    total: 2200, payment: 'Mobile Money', receipt: 'SMS', status: 'paid', branch: 'Kigali HQ'
  },
  {
    id: 'TXN-8839', date: '2026-08-15 13:51', patient: 'Nkurunziza Théo', pharmacist: 'Alice K.',
    items: [{ productId: 'P005', name: 'Insulin Glargine', qty: 1, unitPrice: 8400, total: 8400 }, { productId: 'P002', name: 'Metformin 850mg', qty: 3, unitPrice: 1200, total: 3600 }, { productId: 'P009', name: 'Vitamin D3', qty: 1, unitPrice: 600, total: 600 }, { productId: 'P003', name: 'Paracetamol', qty: 2, unitPrice: 600, total: 1200 }, { productId: 'P010', name: 'Omeprazole', qty: 1, unitPrice: 900, total: 800 }],
    total: 14600, payment: 'Insurance', receipt: 'Physical', status: 'pending', insurance: 'RAMA', branch: 'Musanze'
  },
  {
    id: 'TXN-8838', date: '2026-08-15 13:30', patient: 'Mukamana Grace', pharmacist: 'Claire N.',
    items: [{ productId: 'P003', name: 'Paracetamol 500mg', qty: 6, unitPrice: 600, total: 3600 }, { productId: 'P010', name: 'Omeprazole 20mg', qty: 3, unitPrice: 800, total: 2400 }],
    total: 6000, payment: 'Cash', receipt: 'E-Receipt', status: 'paid', branch: 'Butare'
  },
  {
    id: 'TXN-8837', date: '2026-08-15 13:14', patient: 'Habimana David', pharmacist: 'Bob M.',
    items: [{ productId: 'P007', name: 'Atorvastatin 20mg', qty: 2, unitPrice: 1600, total: 3200 }, { productId: 'P008', name: 'Amlodipine 5mg', qty: 2, unitPrice: 1400, total: 2800 }, { productId: 'P002', name: 'Metformin 850mg', qty: 2, unitPrice: 1200, total: 2400 }, { productId: 'P009', name: 'Vitamin D3', qty: 1, unitPrice: 600, total: 600 }],
    total: 11200, payment: 'Card', receipt: 'E-Receipt', status: 'paid', branch: 'Kigali HQ'
  },
  {
    id: 'TXN-8836', date: '2026-08-15 12:58', patient: 'Iradukunda Rose', pharmacist: 'Claire N.',
    items: [{ productId: 'P011', name: 'Salbutamol 100mcg', qty: 1, unitPrice: 3600, total: 3600 }, { productId: 'P003', name: 'Paracetamol', qty: 1, unitPrice: 600, total: 200 }],
    total: 3800, payment: 'Mobile Money', receipt: 'WhatsApp', status: 'refunded', branch: 'Kigali HQ'
  },
  {
    id: 'TXN-8835', date: '2026-08-15 12:22', patient: 'Nzeyimana Paul', pharmacist: 'Alice K.',
    items: [{ productId: 'P001', name: 'Amoxicillin 500mg', qty: 2, unitPrice: 1500, total: 3000 }, { productId: 'P012', name: 'Hydrocortisone 1%', qty: 1, unitPrice: 2100, total: 2100 }],
    total: 5100, payment: 'Cash', receipt: 'Physical', status: 'paid', branch: 'Gisenyi'
  },
]

// ─── Alerts ───────────────────────────────────────────────────────────────────

export const alertsData: AlertItem[] = [
  { id: 1, type: 'critical', title: 'Zero Stock',       msg: 'Ciprofloxacin 250mg — Branch Kigali HQ', time: '5m ago',  branch: 'Kigali HQ', dismissed: false },
  { id: 2, type: 'warning',  title: 'Near-Expiry',      msg: 'Insulin Glargine — 47 units expire in 14 days', time: '12m ago', branch: 'Musanze',   dismissed: false },
  { id: 3, type: 'warning',  title: 'Low Stock',        msg: 'Metformin 500mg — only 23 units remain (reorder: 150)', time: '28m ago', branch: 'Kigali HQ', dismissed: false },
  { id: 4, type: 'warning',  title: 'Low Stock',        msg: 'Salbutamol 100mcg — only 85 units (reorder: 100)', time: '42m ago', branch: 'Butare',    dismissed: false },
  { id: 5, type: 'info',     title: 'Reorder Point',    msg: 'Amoxicillin 500mg reached reorder threshold (200)', time: '1h ago',  branch: 'Kigali HQ', dismissed: false },
  { id: 6, type: 'info',     title: 'Batch Recall',     msg: 'Supplier anomaly — Batch #RX2024-88 from BioMed Africa', time: '2h ago',  branch: 'All',       dismissed: false },
  { id: 7, type: 'info',     title: 'PO Update',        msg: 'PO #PO-2024-112 received from MedPharm Supplies', time: '3h ago',  branch: 'Kigali HQ', dismissed: false },
  { id: 8, type: 'warning',  title: 'Slow-Moving',      msg: 'Naproxen 500mg — no sales in 30 days, 240 units in stock', time: '5h ago', branch: 'Gisenyi',   dismissed: false },
]

// ─── Insurance ────────────────────────────────────────────────────────────────

export const insuranceProviders: InsuranceProvider[] = [
  { id: 'INS1', name: 'RAMA',             coverage: 80, claims: 58, covered: 920000,  pending: 0,     active: true  },
  { id: 'INS2', name: 'MMI Health',       coverage: 70, claims: 34, covered: 680000,  pending: 84000, active: true  },
  { id: 'INS3', name: 'SONARWA',          coverage: 75, claims: 28, covered: 420000,  pending: 64000, active: true  },
  { id: 'INS4', name: 'Radiant Insurance',coverage: 60, claims: 14, covered: 196000,  pending: 36000, active: true  },
  { id: 'INS5', name: 'RSSB',             coverage: 85, claims: 8,  covered: 84000,   pending: 0,     active: false },
]

// ─── Branches ─────────────────────────────────────────────────────────────────

export const branches = ['All Branches', 'Kigali HQ', 'Musanze', 'Butare', 'Gisenyi']

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const fmtRWF = (n: number) => {
  if (n >= 1000000) return `RWF ${(n / 1000000).toFixed(2)}M`
  if (n >= 1000) return `RWF ${(n / 1000).toFixed(0)}K`
  return `RWF ${n.toLocaleString()}`
}

// Never abbreviates (no "2K" for 2,000) -- for anywhere the exact amount
// matters: printed barcode labels, per-item cost/selling prices, receipts.
// fmtRWF's K/M shorthand stays reserved for big aggregate KPI totals.
export const fmtRWFExact = (n: number) => `RWF ${Math.round(n).toLocaleString()}`

export const pct = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`

export const stockStatusColor = (s: string) => {
  if (s === 'zero')   return '#dc2626'
  if (s === 'low')    return '#d97706'
  if (s === 'expiry') return '#9333ea'
  return '#16a34a'
}

export const stockStatusLabel = (s: string) => {
  if (s === 'zero')   return 'Out of Stock'
  if (s === 'low')    return 'Low Stock'
  if (s === 'expiry') return 'Near Expiry'
  return 'In Stock'
}

export const alertColors = (t: AlertSeverity) => {
  if (t === 'critical') return { bg: '#fef2f2', border: '#fca5a5', text: '#dc2626', dot: '#dc2626' }
  if (t === 'warning')  return { bg: '#fffbeb', border: '#fcd34d', text: '#d97706', dot: '#d97706' }
  return                       { bg: '#f0fdf4', border: '#86efac', text: '#16a34a', dot: '#16a34a' }
}

export const PAGE_LABELS: Record<string, string> = {
  overview:     'Dashboard Overview',
  inventory:    'Inventory Dashboard',
  receiving:    'Receive Stock Delivery',
  barcode:      'Barcode Manager',
  sales:        'Sales & POS',
  analytics:    'Analytics & Forecasting',
  alerts:       'Alerts & Automation',
  transactions: 'Transaction History',
  compliance:   'Government & Compliance',
  insurance:    'Insurance Management',
  branch:       'Branch Settings',
  help:         'Help & Support',
}

// ─── DB-Aligned Types (PostgreSQL schema) ─────────────────────────────────────

export interface DBTaxRate {
  id: string
  name: string                          // 'Standard VAT' | 'Exempt'
  rate_percentage: number
}

export interface DBProductCategory {
  id: string
  branch_id: string
  name: string
  description?: string
}

export interface DBProduct {
  id: string
  tax_rate_id: string
  product_type: 'medicine' | 'supply' | 'other'
  name: string
  generic_name?: string
  description?: string
}

export interface DBProductVariant {
  id: string
  product_id: string
  dosage?: string                       // e.g. '500mg', '850mg'
  form?: string                         // e.g. 'Tablet', 'Capsule', 'Syrup'
  unit?: string                         // e.g. 'per tablet', 'per mL'
}

export interface DBReorderPoint {
  id: string
  product_id: string
  branch_id: string
  min_quantity: number
  max_quantity?: number
}

export interface DBSupplier {
  id: string
  supplier_name: string
  contact?: string
  location?: string
  created_at: string
}

export interface DBStockBatch {
  id: string
  product_variant_id: string
  branch_id: string
  supplier_id?: string
  manufacturer_name?: string
  delivery_code?: string                // groups same-shipment rows
  logged_by: string
  batch_number: string
  expiry_date: string                   // DATE — YYYY-MM-DD
  cost_price: number                    // per piece
  selling_price: number                 // per piece
  quantity_received: number
  received_at: string
}

export interface DBBarcode {
  id: string
  stock_batch_id: string
  parent_barcode_id?: string            // pack's parent box
  barcode_type: 'box' | 'pack'
  code: string
  code_source: 'manufacturer' | 'generated'
  child_count?: number                  // box only: how many packs inside
  pieces_per_pack?: number              // pack only: pieces inside this pack
  quantity_available: number
  status: 'active' | 'sold_out' | 'expired' | 'recalled' | 'damaged'
  created_at: string
}

export interface DBBatchRecall {
  id: string
  product_variant_id: string
  batch_number: string
  manufacturer_name?: string
  reason: string
  recalled_by: string
  recalled_at: string
}

export interface DBStockAdjustment {
  id: string
  stock_batch_id?: string
  barcode_id?: string
  adjustment_type: 'damage' | 'loss' | 'correction' | 'return' | 'expired_writeoff' | 'recalled'
  quantity: number
  reason?: string
  performed_by: string
  adjusted_at: string
}

export interface DBDiscount {
  id: string
  name: string
  discount_type: 'percentage' | 'fixed'
  value: number
  valid_from?: string
  valid_to?: string
}

export interface DBInsuranceClaim {
  id: string
  sale_id: string
  insurance_provider_id: string
  coverage_percentage_applied: number
  claim_amount: number
  status: 'submitted' | 'approved' | 'rejected' | 'paid'
  submitted_at: string
}

export interface DBNotification {
  id: string
  branch_id: string
  source_type: 'batch_recall' | 'stock_adjustment'
  source_id: string
  message: string
  is_read: boolean
  created_at: string
}

export interface DBSupportTicket {
  id: string
  branch_id: string
  raised_by: string
  subject: string
  description?: string
  status: 'open' | 'in_progress' | 'resolved' | 'closed'
  created_at: string
}

// ─── DB Seed Data ─────────────────────────────────────────────────────────────

export const dbTaxRates: DBTaxRate[] = [
  { id: 'TR-001', name: 'Standard VAT', rate_percentage: 18 },
  { id: 'TR-002', name: 'Exempt',       rate_percentage: 0  },
]

export const dbProductCategories: DBProductCategory[] = [
  { id: 'CAT-001', branch_id: 'BR-001', name: 'Antibiotics',      description: 'Antibacterial medications' },
  { id: 'CAT-002', branch_id: 'BR-001', name: 'Analgesics',       description: 'Pain relief medications' },
  { id: 'CAT-003', branch_id: 'BR-001', name: 'Vitamins',         description: 'Dietary supplements' },
  { id: 'CAT-004', branch_id: 'BR-001', name: 'Antidiabetics',    description: 'Diabetes management' },
  { id: 'CAT-005', branch_id: 'BR-001', name: 'Cardiovascular',   description: 'Heart and blood pressure medications' },
  { id: 'CAT-006', branch_id: 'BR-001', name: 'Respiratory',      description: 'Asthma and respiratory medications' },
  { id: 'CAT-007', branch_id: 'BR-001', name: 'Dermatology',      description: 'Skin care and topical medications' },
  { id: 'CAT-008', branch_id: 'BR-001', name: 'Gastrointestinal', description: 'Digestive health medications' },
]

export const dbProducts: DBProduct[] = [
  { id: 'P001', tax_rate_id: 'TR-001', product_type: 'medicine', name: 'Amoxicillin',    generic_name: 'Amoxicillin Trihydrate', description: 'Broad-spectrum antibiotic' },
  { id: 'P002', tax_rate_id: 'TR-001', product_type: 'medicine', name: 'Metformin',      generic_name: 'Metformin Hydrochloride', description: 'Type 2 diabetes management' },
  { id: 'P003', tax_rate_id: 'TR-002', product_type: 'medicine', name: 'Paracetamol',    generic_name: 'Acetaminophen', description: 'Analgesic and antipyretic' },
  { id: 'P004', tax_rate_id: 'TR-001', product_type: 'medicine', name: 'Ciprofloxacin',  generic_name: 'Ciprofloxacin Hydrochloride', description: 'Fluoroquinolone antibiotic' },
  { id: 'P005', tax_rate_id: 'TR-001', product_type: 'medicine', name: 'Insulin Glargine', generic_name: 'Insulin Glargine', description: 'Long-acting insulin analog' },
  { id: 'P006', tax_rate_id: 'TR-001', product_type: 'medicine', name: 'Atorvastatin',   generic_name: 'Atorvastatin Calcium', description: 'Statin for cholesterol management' },
  { id: 'P007', tax_rate_id: 'TR-001', product_type: 'medicine', name: 'Amlodipine',     generic_name: 'Amlodipine Besylate', description: 'Calcium channel blocker' },
  { id: 'P008', tax_rate_id: 'TR-002', product_type: 'medicine', name: 'Vitamin D3',     generic_name: 'Cholecalciferol', description: 'Fat-soluble vitamin supplement' },
  { id: 'P009', tax_rate_id: 'TR-001', product_type: 'medicine', name: 'Omeprazole',     generic_name: 'Omeprazole Magnesium', description: 'Proton pump inhibitor' },
  { id: 'P010', tax_rate_id: 'TR-001', product_type: 'medicine', name: 'Salbutamol',     generic_name: 'Albuterol', description: 'Beta-2 agonist bronchodilator' },
  { id: 'P011', tax_rate_id: 'TR-001', product_type: 'medicine', name: 'Hydrocortisone', generic_name: 'Hydrocortisone Acetate', description: 'Topical corticosteroid' },
  { id: 'P012', tax_rate_id: 'TR-002', product_type: 'supply',   name: 'Disposable Gloves', generic_name: undefined, description: 'Latex-free examination gloves' },
]

export const dbProductVariants: DBProductVariant[] = [
  { id: 'PV-001', product_id: 'P001', dosage: '500mg',   form: 'Capsule',   unit: 'per capsule' },
  { id: 'PV-002', product_id: 'P001', dosage: '250mg',   form: 'Tablet',    unit: 'per tablet' },
  { id: 'PV-003', product_id: 'P002', dosage: '850mg',   form: 'Tablet',    unit: 'per tablet' },
  { id: 'PV-004', product_id: 'P002', dosage: '500mg',   form: 'Tablet',    unit: 'per tablet' },
  { id: 'PV-005', product_id: 'P003', dosage: '500mg',   form: 'Tablet',    unit: 'per tablet' },
  { id: 'PV-006', product_id: 'P004', dosage: '250mg',   form: 'Tablet',    unit: 'per tablet' },
  { id: 'PV-007', product_id: 'P005', dosage: '100IU/mL',form: 'Injection', unit: 'per 10mL vial' },
  { id: 'PV-008', product_id: 'P006', dosage: '20mg',    form: 'Tablet',    unit: 'per tablet' },
  { id: 'PV-009', product_id: 'P007', dosage: '5mg',     form: 'Tablet',    unit: 'per tablet' },
  { id: 'PV-010', product_id: 'P008', dosage: '1000IU',  form: 'Capsule',   unit: 'per capsule' },
  { id: 'PV-011', product_id: 'P009', dosage: '20mg',    form: 'Capsule',   unit: 'per capsule' },
  { id: 'PV-012', product_id: 'P010', dosage: '100mcg',  form: 'Inhaler',   unit: 'per dose' },
  { id: 'PV-013', product_id: 'P011', dosage: '1%',      form: 'Cream',     unit: 'per 15g tube' },
  { id: 'PV-014', product_id: 'P012', dosage: undefined, form: 'Box',       unit: 'per box of 100' },
]

export const dbReorderPoints: DBReorderPoint[] = [
  { id: 'RP-001', product_id: 'P001', branch_id: 'BR-001', min_quantity: 200, max_quantity: 1000 },
  { id: 'RP-002', product_id: 'P002', branch_id: 'BR-001', min_quantity: 150, max_quantity: 800 },
  { id: 'RP-003', product_id: 'P003', branch_id: 'BR-001', min_quantity: 500, max_quantity: 2000 },
  { id: 'RP-004', product_id: 'P004', branch_id: 'BR-001', min_quantity: 100, max_quantity: 500 },
  { id: 'RP-005', product_id: 'P005', branch_id: 'BR-001', min_quantity: 50,  max_quantity: 200 },
  { id: 'RP-006', product_id: 'P006', branch_id: 'BR-001', min_quantity: 100, max_quantity: 400 },
  { id: 'RP-007', product_id: 'P007', branch_id: 'BR-001', min_quantity: 120, max_quantity: 600 },
  { id: 'RP-008', product_id: 'P008', branch_id: 'BR-001', min_quantity: 300, max_quantity: 1500 },
  { id: 'RP-009', product_id: 'P009', branch_id: 'BR-001', min_quantity: 180, max_quantity: 800 },
  { id: 'RP-010', product_id: 'P010', branch_id: 'BR-001', min_quantity: 100, max_quantity: 400 },
]

export const dbSuppliers: DBSupplier[] = [
  { id: 'SUP-001', supplier_name: 'MedPharm Supplies',   contact: '+250 788 001 001', location: 'Kigali, Rwanda',   created_at: '2024-01-10' },
  { id: 'SUP-002', supplier_name: 'Rwanda Pharma Ltd',   contact: '+250 788 002 002', location: 'Kigali, Rwanda',   created_at: '2024-01-15' },
  { id: 'SUP-003', supplier_name: 'HealthPlus RW',       contact: '+250 788 003 003', location: 'Musanze, Rwanda',  created_at: '2024-02-01' },
  { id: 'SUP-004', supplier_name: 'BioMed Africa',       contact: '+250 788 004 004', location: 'Nairobi, Kenya',   created_at: '2024-02-10' },
  { id: 'SUP-005', supplier_name: 'CardioMed Ltd',       contact: '+250 788 005 005', location: 'Kigali, Rwanda',   created_at: '2024-03-01' },
  { id: 'SUP-006', supplier_name: 'NutriHealth RW',      contact: '+250 788 006 006', location: 'Butare, Rwanda',   created_at: '2024-03-15' },
  { id: 'SUP-007', supplier_name: 'RespiCare Ltd',       contact: '+250 788 007 007', location: 'Kigali, Rwanda',   created_at: '2024-04-01' },
  { id: 'SUP-008', supplier_name: 'DermaPharm RW',       contact: '+250 788 008 008', location: 'Kigali, Rwanda',   created_at: '2024-04-15' },
]

export const dbStockBatches: DBStockBatch[] = [
  { id: 'SB-001', product_variant_id: 'PV-001', branch_id: 'BR-001', supplier_id: 'SUP-001', manufacturer_name: 'GSK Rwanda', delivery_code: 'DEL-2026-0038', logged_by: 'U-001', batch_number: 'BT-2026-441', expiry_date: '2027-08-31', cost_price: 1100, selling_price: 1500, quantity_received: 40,   received_at: '2026-08-10' },
  { id: 'SB-002', product_variant_id: 'PV-003', branch_id: 'BR-001', supplier_id: 'SUP-002', manufacturer_name: 'Rorer Africa', delivery_code: 'DEL-2026-0039', logged_by: 'U-001', batch_number: 'BT-2026-289', expiry_date: '2027-06-30', cost_price: 850,  selling_price: 1200, quantity_received: 60,   received_at: '2026-08-12' },
  { id: 'SB-003', product_variant_id: 'PV-005', branch_id: 'BR-001', supplier_id: 'SUP-003', manufacturer_name: 'LocalPharma RW', delivery_code: 'DEL-2026-0040', logged_by: 'U-001', batch_number: 'BT-2026-512', expiry_date: '2025-12-31', cost_price: 380,  selling_price: 600,  quantity_received: 200,  received_at: '2026-08-13' },
  { id: 'SB-004', product_variant_id: 'PV-006', branch_id: 'BR-001', supplier_id: 'SUP-001', manufacturer_name: 'Cipla Africa', delivery_code: 'DEL-2026-0041', logged_by: 'U-001', batch_number: 'BT-2026-098', expiry_date: '2026-06-30', cost_price: 1600, selling_price: 2200, quantity_received: 100,  received_at: '2026-08-01' },
  { id: 'SB-005', product_variant_id: 'PV-007', branch_id: 'BR-001', supplier_id: 'SUP-004', manufacturer_name: 'Sanofi Africa', delivery_code: 'DEL-2026-0042', logged_by: 'U-002', batch_number: 'BT-2026-771', expiry_date: '2024-10-31', cost_price: 6200, selling_price: 8400, quantity_received: 50,   received_at: '2026-07-20' },
  { id: 'SB-006', product_variant_id: 'PV-004', branch_id: 'BR-001', supplier_id: 'SUP-002', manufacturer_name: 'Rorer Africa', delivery_code: 'DEL-2026-0039', logged_by: 'U-001', batch_number: 'BT-2026-304', expiry_date: '2026-09-30', cost_price: 720,  selling_price: 1000, quantity_received: 80,   received_at: '2026-08-12' },
  { id: 'SB-007', product_variant_id: 'PV-008', branch_id: 'BR-001', supplier_id: 'SUP-005', manufacturer_name: 'Pfizer Africa', delivery_code: 'DEL-2026-0043', logged_by: 'U-001', batch_number: 'BT-2026-556', expiry_date: '2027-01-31', cost_price: 1150, selling_price: 1600, quantity_received: 120,  received_at: '2026-08-05' },
  { id: 'SB-008', product_variant_id: 'PV-009', branch_id: 'BR-001', supplier_id: 'SUP-005', manufacturer_name: 'Pfizer Africa', delivery_code: 'DEL-2026-0043', logged_by: 'U-001', batch_number: 'BT-2026-612', expiry_date: '2026-11-30', cost_price: 980,  selling_price: 1400, quantity_received: 120,  received_at: '2026-08-05' },
  { id: 'SB-009', product_variant_id: 'PV-010', branch_id: 'BR-001', supplier_id: 'SUP-006', manufacturer_name: 'NutriCorp', delivery_code: 'DEL-2026-0044', logged_by: 'U-002', batch_number: 'BT-2026-881', expiry_date: '2027-06-30', cost_price: 410,  selling_price: 600,  quantity_received: 300,  received_at: '2026-08-08' },
  { id: 'SB-010', product_variant_id: 'PV-011', branch_id: 'BR-001', supplier_id: 'SUP-003', manufacturer_name: 'AstraZeneca', delivery_code: 'DEL-2026-0040', logged_by: 'U-001', batch_number: 'BT-2026-334', expiry_date: '2026-04-30', cost_price: 640,  selling_price: 900,  quantity_received: 150,  received_at: '2026-08-13' },
  { id: 'SB-011', product_variant_id: 'PV-012', branch_id: 'BR-001', supplier_id: 'SUP-007', manufacturer_name: 'GlaxoSmithKline', delivery_code: 'DEL-2026-0045', logged_by: 'U-001', batch_number: 'BT-2026-203', expiry_date: '2026-02-28', cost_price: 2600, selling_price: 3600, quantity_received: 100,  received_at: '2026-08-10' },
  { id: 'SB-012', product_variant_id: 'PV-013', branch_id: 'BR-001', supplier_id: 'SUP-008', manufacturer_name: 'DermCorp RW', delivery_code: 'DEL-2026-0046', logged_by: 'U-002', batch_number: 'BT-2026-719', expiry_date: '2026-10-31', cost_price: 1500, selling_price: 2100, quantity_received: 80,   received_at: '2026-08-14' },
]

export const dbBarcodes: DBBarcode[] = [
  // SB-001: Box barcode (contains 40 packs) + sample pack
  { id: 'BC-B001', stock_batch_id: 'SB-001', barcode_type: 'box',  code: 'PSBULK003840040', code_source: 'generated', child_count: 40, quantity_available: 34, status: 'active', created_at: '2026-08-10' },
  { id: 'BC-P001', stock_batch_id: 'SB-001', parent_barcode_id: 'BC-B001', barcode_type: 'pack', code: 'PSANT20260838001', code_source: 'generated', pieces_per_pack: 1, quantity_available: 1, status: 'active', created_at: '2026-08-10' },
  // SB-002: Box + sample pack
  { id: 'BC-B002', stock_batch_id: 'SB-002', barcode_type: 'box',  code: 'PSBULK003960060', code_source: 'generated', child_count: 60, quantity_available: 48, status: 'active', created_at: '2026-08-12' },
  { id: 'BC-P002', stock_batch_id: 'SB-002', parent_barcode_id: 'BC-B002', barcode_type: 'pack', code: 'PSADB20260839001', code_source: 'generated', pieces_per_pack: 1, quantity_available: 1, status: 'active', created_at: '2026-08-12' },
  // SB-003: Manufacturer barcode (came with product)
  { id: 'BC-B003', stock_batch_id: 'SB-003', barcode_type: 'box',  code: 'MFGPCT2026512200', code_source: 'manufacturer', child_count: 10, quantity_available: 200, status: 'active', created_at: '2026-08-13' },
  // SB-004: Out-of-stock
  { id: 'BC-B004', stock_batch_id: 'SB-004', barcode_type: 'box',  code: 'PSBULK004100100', code_source: 'generated', child_count: 100, quantity_available: 0, status: 'sold_out', created_at: '2026-08-01' },
  // SB-005: Expired
  { id: 'BC-B005', stock_batch_id: 'SB-005', barcode_type: 'box',  code: 'PSBULK004250050', code_source: 'generated', child_count: 50, quantity_available: 47, status: 'expired', created_at: '2026-07-20' },
  // SB-011: Recalled
  { id: 'BC-B011', stock_batch_id: 'SB-011', barcode_type: 'box',  code: 'PSBULK004510100', code_source: 'generated', child_count: 100, quantity_available: 85, status: 'recalled', created_at: '2026-08-10' },
]

export const dbBatchRecalls: DBBatchRecall[] = [
  {
    id: 'RCL-001', product_variant_id: 'PV-012', batch_number: 'BT-2026-203',
    manufacturer_name: 'GlaxoSmithKline', reason: 'Potential contamination detected in inhaler propellant. Recall issued by manufacturer. Do not dispense.',
    recalled_by: 'U-001', recalled_at: '2026-08-14 10:30',
  },
]

export const dbStockAdjustments: DBStockAdjustment[] = [
  { id: 'ADJ-001', stock_batch_id: 'SB-003', adjustment_type: 'expired_writeoff', quantity: -48, reason: 'Batch partially expired — 48 near-expiry packs written off', performed_by: 'U-001', adjusted_at: '2026-08-15 09:00' },
  { id: 'ADJ-002', barcode_id: 'BC-P001', adjustment_type: 'damage', quantity: -2, reason: 'Dropped and broken during stock check', performed_by: 'U-002', adjusted_at: '2026-08-14 15:30' },
  { id: 'ADJ-003', stock_batch_id: 'SB-006', adjustment_type: 'correction', quantity: 5, reason: 'Count discrepancy corrected after physical audit', performed_by: 'U-001', adjusted_at: '2026-08-13 11:00' },
  { id: 'ADJ-004', stock_batch_id: 'SB-011', adjustment_type: 'recalled', quantity: -85, reason: 'Full batch recalled — see RCL-001', performed_by: 'U-001', adjusted_at: '2026-08-14 11:00' },
]

export const dbDiscounts: DBDiscount[] = [
  { id: 'DIS-001', name: 'Senior Citizen 10%', discount_type: 'percentage', value: 10, valid_from: '2026-01-01', valid_to: '2026-12-31' },
  { id: 'DIS-002', name: 'Wholesale Fixed',    discount_type: 'fixed',      value: 500, valid_from: '2026-01-01', valid_to: '2026-12-31' },
  { id: 'DIS-003', name: 'Staff 15%',          discount_type: 'percentage', value: 15, valid_from: '2026-01-01', valid_to: '2026-12-31' },
  { id: 'DIS-004', name: 'Loyalty 5%',         discount_type: 'percentage', value: 5,  valid_from: '2026-06-01', valid_to: '2026-12-31' },
]

export interface DBInsuranceProvider {
  id: string
  name: string
  contact_info?: string
  default_coverage_percentage: number
}

export const dbInsuranceProviders: DBInsuranceProvider[] = [
  { id: 'INS1', name: 'RAMA Health',      contact_info: 'rama@rssb.rw · +250 788 100 001', default_coverage_percentage: 80 },
  { id: 'INS2', name: 'MMI Health',       contact_info: 'mmi@health.rw · +250 788 200 002', default_coverage_percentage: 70 },
  { id: 'INS3', name: 'SORAS Insurance',  contact_info: 'claims@soras.rw · +250 788 300 003', default_coverage_percentage: 75 },
  { id: 'INS4', name: 'UAP Insurance',    contact_info: 'uap@uap-rwanda.com · +250 788 400 004', default_coverage_percentage: 60 },
  { id: 'INS5', name: 'Jubilee Rwanda',   contact_info: 'jubilee@jubilee.rw · +250 788 500 005', default_coverage_percentage: 65 },
]

export interface DBUser {
  id: string
  branch_id: string
  full_name: string
  email: string
  role: string
}

export const dbUsers: DBUser[] = [
  { id: 'USR-001', branch_id: 'BR-001', full_name: 'Alice Uwase',         email: 'alice@pharmsync.rw',   role: 'owner' },
  { id: 'USR-002', branch_id: 'BR-002', full_name: 'Patrick Nkurunziza',  email: 'patrick@pharmsync.rw', role: 'manager' },
  { id: 'USR-003', branch_id: 'BR-003', full_name: 'Diane Uwimana',       email: 'diane@pharmsync.rw',   role: 'pharmacist' },
  { id: 'USR-004', branch_id: 'BR-004', full_name: 'Eva Mukamana',        email: 'eva@pharmsync.rw',     role: 'pharmacist' },
  { id: 'USR-005', branch_id: 'BR-001', full_name: 'Bob Mugisha',         email: 'bob@pharmsync.rw',     role: 'staff' },
]

export const dbInsuranceClaims: DBInsuranceClaim[] = [
  { id: 'CLM-001', sale_id: 'TXN-8839', insurance_provider_id: 'INS1', coverage_percentage_applied: 80, claim_amount: 11680, status: 'approved',  submitted_at: '2026-08-15 14:00' },
  { id: 'CLM-002', sale_id: 'TXN-8830', insurance_provider_id: 'INS2', coverage_percentage_applied: 70, claim_amount: 8400,  status: 'submitted', submitted_at: '2026-08-14 11:30' },
  { id: 'CLM-003', sale_id: 'TXN-8821', insurance_provider_id: 'INS1', coverage_percentage_applied: 80, claim_amount: 9600,  status: 'paid',      submitted_at: '2026-08-13 09:15' },
  { id: 'CLM-004', sale_id: 'TXN-8810', insurance_provider_id: 'INS3', coverage_percentage_applied: 75, claim_amount: 5250,  status: 'rejected',  submitted_at: '2026-08-12 16:45' },
  { id: 'CLM-005', sale_id: 'TXN-8799', insurance_provider_id: 'INS4', coverage_percentage_applied: 60, claim_amount: 3600,  status: 'submitted', submitted_at: '2026-08-11 10:00' },
]

export const dbNotifications: DBNotification[] = [
  { id: 'NTF-001', branch_id: 'BR-001', source_type: 'stock_adjustment', source_id: 'ADJ-001', message: 'Expired writeoff: 48 units of Paracetamol 500mg removed from stock (Batch BT-2026-512)', is_read: false, created_at: '2026-08-15 09:00' },
  { id: 'NTF-002', branch_id: 'BR-001', source_type: 'batch_recall', source_id: 'RCL-001', message: 'URGENT RECALL: Salbutamol 100mcg Batch BT-2026-203 recalled by GlaxoSmithKline. 85 units quarantined.', is_read: false, created_at: '2026-08-14 10:30' },
  { id: 'NTF-003', branch_id: 'BR-001', source_type: 'stock_adjustment', source_id: 'ADJ-002', message: 'Damage reported: 2 units of Amoxicillin 500mg written off (breakage during stock check)', is_read: false, created_at: '2026-08-14 15:30' },
  { id: 'NTF-004', branch_id: 'BR-001', source_type: 'stock_adjustment', source_id: 'ADJ-003', message: 'Stock correction: Metformin 500mg adjusted +5 units after physical audit discrepancy', is_read: true,  created_at: '2026-08-13 11:00' },
  { id: 'NTF-005', branch_id: 'BR-001', source_type: 'batch_recall', source_id: 'RCL-001', message: 'Batch recall ADJ-004 processed: 85 units recalled from Salbutamol 100mcg', is_read: true,  created_at: '2026-08-14 11:00' },
]

export const dbSupportTickets: DBSupportTicket[] = [
  { id: 'TK-001', branch_id: 'BR-002', raised_by: 'Patrick Nkurunziza', subject: 'Scanner not reading bulk barcodes after power outage', description: 'After a power outage at Musanze, the barcode scanner stopped reading the bulk (box) barcodes. Pack barcodes still work. About 80 units waiting to enter stock.', status: 'in_progress', created_at: '2026-08-15 11:30' },
  { id: 'TK-002', branch_id: 'BR-001', raised_by: 'Bob Mugisha', subject: 'Add expiry date on barcode label printout', description: 'Printed labels should show a large bold expiry_date field. Pharmacists miss the small expiry text when stocking shelves.', status: 'open', created_at: '2026-08-14 09:15' },
  { id: 'TK-003', branch_id: 'BR-003', raised_by: 'Diane Uwimana', subject: 'Insurance coverage_percentage_applied showing wrong rate for MMI', description: 'MMI Health showing 70% but agreed coverage_percentage_applied is 75%. Causing underclaiming on patient bills.', status: 'resolved', created_at: '2026-08-13 14:22' },
  { id: 'TK-004', branch_id: 'BR-004', raised_by: 'Eva Mukamana', subject: 'Offline sale recording with sync on reconnect', description: '3-hour internet outage stopped us from entering sales. Need offline queue that syncs stock and RRA data on reconnect.', status: 'open', created_at: '2026-08-12 16:00' },
  { id: 'TK-005', branch_id: 'BR-002', raised_by: 'Patrick Nkurunziza', subject: 'Show break-even point on monthly dashboard', description: 'As branch manager, I want to see at a glance whether we are above or below break-even without manually computing from the P&L.', status: 'resolved', created_at: '2026-08-10 10:05' },
]

// ─── Branch Registry (for Admin panel) ───────────────────────────────────────

export interface BranchRecord {
  id: string
  name: string
  address: string
  manager: string
  phone: string
  tin: string
  status: 'active' | 'inactive' | 'pending'
  registeredAt: string
  accessCode?: string
  accessCodeExpiry?: string
  revenue: number
  staff: number
  pharmacists: string[]
}

export const branchRegistry: BranchRecord[] = [
  {
    id: 'BR-001', name: 'Kigali HQ', address: 'KG 12 Ave, Kiyovu, Kigali',
    manager: 'Dr. Alice Kayitesi', phone: '+250 788 123 456', tin: '102381027',
    status: 'active', registeredAt: '2024-01-15',
    accessCode: 'KHQ-2026-A4F2', accessCodeExpiry: '2027-01-15',
    revenue: 3840000, staff: 8, pharmacists: ['Bob Mugisha', 'Claire Nzeyimana'],
  },
  {
    id: 'BR-002', name: 'Musanze', address: 'Musanze Market Street, Ruhengeri',
    manager: 'Pharm. Bob Mugisha', phone: '+250 788 234 567', tin: '102381028',
    status: 'active', registeredAt: '2024-03-10',
    accessCode: 'MSZ-2026-B7C9', accessCodeExpiry: '2027-03-10',
    revenue: 1280000, staff: 4, pharmacists: ['Patrick Nkurunziza'],
  },
  {
    id: 'BR-003', name: 'Butare', address: 'NUR Campus Road, Huye',
    manager: 'Pharm. Claire Nzeyimana', phone: '+250 788 345 678', tin: '102381029',
    status: 'active', registeredAt: '2024-06-20',
    accessCode: 'BUT-2026-D3E8', accessCodeExpiry: '2027-06-20',
    revenue: 760000, staff: 3, pharmacists: ['Diane Uwimana'],
  },
  {
    id: 'BR-004', name: 'Gisenyi', address: 'Rubavu Lakeshore Road',
    manager: 'Pharm. David Habimana', phone: '+250 788 456 789', tin: '102381030',
    status: 'active', registeredAt: '2024-09-05',
    accessCode: 'GIS-2026-F1G6', accessCodeExpiry: '2027-09-05',
    revenue: 520000, staff: 3, pharmacists: ['Eva Mukamana'],
  },
  {
    id: 'BR-005', name: 'Ruhango', address: 'TBD — Opening Oct 2026',
    manager: '—', phone: '—', tin: '—',
    status: 'pending', registeredAt: '2026-08-01',
    revenue: 0, staff: 0, pharmacists: [],
  },
]

// ─── Help Tickets ──────────────────────────────────────────────────────────────

export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed'
export type TicketType   = 'help' | 'suggestion' | 'bug' | 'feature'

export interface HelpTicket {
  id: string
  type: TicketType
  title: string
  body: string
  branch: string
  author: string
  createdAt: string
  status: TicketStatus
  priority: 'low' | 'medium' | 'high'
  adminReply?: string
  repliedAt?: string
}

export const helpTickets: HelpTicket[] = [
  {
    id: 'TK-001', type: 'help', priority: 'high',
    title: 'Scanner not reading bulk barcodes after power outage',
    body: 'After a power outage at Musanze, the barcode scanner stopped reading the bulk barcodes generated last week. Individual piece barcodes still work. We have about 80 units waiting to enter stock.',
    branch: 'Musanze', author: 'Patrick Nkurunziza',
    createdAt: '2026-08-15 11:30', status: 'in_progress',
    adminReply: 'Investigating — likely a sync issue. Please try regenerating the bulk barcode from the session in Barcode Manager. Will follow up by EOD.',
    repliedAt: '2026-08-15 13:00',
  },
  {
    id: 'TK-002', type: 'suggestion', priority: 'medium',
    title: 'Add expiry date alert to barcode label printout',
    body: 'It would be very helpful if the printed barcode labels also showed a large, bold expiry date. Currently it is small and pharmacists sometimes miss it when stocking shelves.',
    branch: 'Kigali HQ', author: 'Bob Mugisha',
    createdAt: '2026-08-14 09:15', status: 'open',
  },
  {
    id: 'TK-003', type: 'bug', priority: 'medium',
    title: 'Insurance claim shows wrong coverage percentage for MMI',
    body: 'MMI Health is showing 70% coverage but the actual agreed rate is 75%. This is causing underclaiming on patient bills. Please update the coverage in the system.',
    branch: 'Butare', author: 'Diane Uwimana',
    createdAt: '2026-08-13 14:22', status: 'resolved',
    adminReply: 'Fixed — MMI coverage updated to 75% as per contract #MMI-2026-RW. Change will reflect from next billing cycle.',
    repliedAt: '2026-08-13 16:45',
  },
  {
    id: 'TK-004', type: 'feature', priority: 'low',
    title: 'Allow offline sale recording with sync on reconnect',
    body: 'We had an internet outage for 3 hours yesterday and had to stop serving patients because we could not enter sales. An offline queue feature would solve this.',
    branch: 'Gisenyi', author: 'Eva Mukamana',
    createdAt: '2026-08-12 16:00', status: 'open',
  },
  {
    id: 'TK-005', type: 'suggestion', priority: 'low',
    title: 'Show break-even point on monthly dashboard',
    body: 'As branch manager, I want to quickly see whether we are above or below break-even each month without having to manually calculate from the P&L reports.',
    branch: 'Musanze', author: 'Patrick Nkurunziza',
    createdAt: '2026-08-10 10:05', status: 'resolved',
    adminReply: 'Great suggestion! Adding break-even analysis to the Pharmacist Dashboard in the next update.',
    repliedAt: '2026-08-11 09:00',
  },
]

// ─── Break-even Data ───────────────────────────────────────────────────────────

export const breakEvenData = [
  { month: 'Jan', revenue: 4200000, fixedCosts: 1800000, variableCosts: 2100000, totalCosts: 3900000 },
  { month: 'Feb', revenue: 3800000, fixedCosts: 1800000, variableCosts: 1950000, totalCosts: 3750000 },
  { month: 'Mar', revenue: 5100000, fixedCosts: 1800000, variableCosts: 2400000, totalCosts: 4200000 },
  { month: 'Apr', revenue: 4700000, fixedCosts: 1800000, variableCosts: 2200000, totalCosts: 4000000 },
  { month: 'May', revenue: 5600000, fixedCosts: 1800000, variableCosts: 2600000, totalCosts: 4400000 },
  { month: 'Jun', revenue: 6100000, fixedCosts: 1800000, variableCosts: 2800000, totalCosts: 4600000 },
  { month: 'Jul', revenue: 5800000, fixedCosts: 1800000, variableCosts: 2650000, totalCosts: 4450000 },
  { month: 'Aug', revenue: 6400000, fixedCosts: 1800000, variableCosts: 2900000, totalCosts: 4700000 },
]

// Fixed costs / (1 - variable cost ratio) = break-even revenue
// Variable cost ratio = variable / revenue ~ 0.45
// Break-even = 1800000 / (1 - 0.45) = 1800000 / 0.55 ≈ 3,272,727
export const BREAK_EVEN_REVENUE = 3272727

// ─── Simple AI Insights (moving-average based) ────────────────────────────────

export function movingAverage(data: number[], window: number): number[] {
  return data.map((_, i) => {
    const start = Math.max(0, i - window + 1)
    const slice = data.slice(start, i + 1)
    return Math.round(slice.reduce((a, b) => a + b, 0) / slice.length)
  })
}

export function linearTrendForecast(data: number[], stepsAhead: number): number {
  const n = data.length
  const xMean = (n - 1) / 2
  const yMean = data.reduce((a, b) => a + b, 0) / n
  let num = 0, den = 0
  data.forEach((y, x) => { num += (x - xMean) * (y - yMean); den += (x - xMean) ** 2 })
  const slope = den === 0 ? 0 : num / den
  return Math.round(yMean + slope * (n - 1 + stepsAhead - xMean))
}

export function generateSmartInsights(revenueArr: number[], profitArr: number[]): string[] {
  const ma3 = movingAverage(revenueArr, 3)
  const lastRev = revenueArr[revenueArr.length - 1]
  const forecast = linearTrendForecast(revenueArr, 1)
  const growthTrend = ((lastRev - revenueArr[0]) / revenueArr[0] * 100).toFixed(1)
  const profitMargin = ((profitArr[profitArr.length - 1] / lastRev) * 100).toFixed(1)
  const isTrendingUp = forecast > lastRev

  return [
    `Revenue has grown ${growthTrend}% over the tracked period. Trend is ${isTrendingUp ? '↑ upward' : '↓ softening'} — next month est. RWF ${(forecast / 1000000).toFixed(2)}M.`,
    `Current profit margin is ${profitMargin}%. ${Number(profitMargin) > 25 ? 'Above the 25% benchmark — healthy.' : 'Below 25% benchmark — review supplier costs.'}`,
    `3-month revenue average: RWF ${(ma3[ma3.length - 1] / 1000000).toFixed(2)}M. ${lastRev > ma3[ma3.length - 1] ? 'This month is outperforming the recent average.' : 'This month is below recent average — check slow-moving stock.'}`,
    `Break-even was cleared ${revenueArr.filter(r => r >= BREAK_EVEN_REVENUE).length} of ${revenueArr.length} months. ${revenueArr[revenueArr.length - 1] >= BREAK_EVEN_REVENUE ? 'Currently above break-even ✓' : 'Currently below break-even — action needed.'}`,
  ]
}
