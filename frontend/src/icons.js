import {
  School, User, LayoutDashboard, Users, Tag, Pencil, ClipboardList,
  TrendingUp, Star, LayoutGrid, Phone, Target, DollarSign, FileText,
  Trophy, Activity, BookOpen, Brain, Shield, Plus, Download, Upload,
  BarChart3, CheckCircle, Clock, XCircle, ExternalLink, Dumbbell,
  Moon, Sun, Cloud, CloudRain, CloudDrizzle, CloudSnow, CloudSun,
  ChevronRight, Search, Trash2, Edit3, MoreHorizontal
} from 'lucide-vue-next'

export const ICONS = {
  School, User, LayoutDashboard, Users, Tag, Pencil, ClipboardList,
  TrendingUp, Star, LayoutGrid, Phone, Target, DollarSign, FileText,
  Trophy, Activity, BookOpen, Brain, Shield, Plus, Download, Upload,
  BarChart3, CheckCircle, Clock, XCircle, ExternalLink, Dumbbell,
  Moon, Sun, Cloud, CloudRain, CloudDrizzle, CloudSnow, CloudSun,
  ChevronRight, Search, Trash2, Edit3, MoreHorizontal
}

export function getIcon(name) {
  return ICONS[name] || null
}
