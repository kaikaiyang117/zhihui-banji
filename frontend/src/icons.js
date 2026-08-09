import {
  School, User, LayoutDashboard, Users, Tag, Pencil, ClipboardList, ClipboardCheck,
  FolderCheck,
  TrendingUp, Star, LayoutGrid, Phone, Presentation, DollarSign, FileText,
  CalendarDays, Activity, BookOpen, Brain, Plus, Download, Upload,
  BarChart3, CheckCircle, Clock, XCircle, ExternalLink, Dumbbell,
  Moon, FileEdit, FileDown, ChevronRight, Search, Trash2, Edit3,
  ListTodo, ShieldCheck, CircleAlert,
  MoreHorizontal, Wifi, QrCode, X, Copy, Check
} from 'lucide-vue-next'

export const ICONS = {
  School, User, LayoutDashboard, Users, Tag, Pencil, ClipboardList, ClipboardCheck,
  FolderCheck,
  TrendingUp, Star, LayoutGrid, Phone, Presentation, DollarSign, FileText,
  CalendarDays, Activity, BookOpen, Brain, Plus, Download, Upload,
  BarChart3, CheckCircle, Clock, XCircle, ExternalLink, Dumbbell,
  Moon, FileEdit, FileDown, ChevronRight, Search, Trash2, Edit3,
  ListTodo, ShieldCheck, CircleAlert,
  MoreHorizontal, Wifi, QrCode, X, Copy, Check
}

export function getIcon(name) {
  return ICONS[name] || null
}
