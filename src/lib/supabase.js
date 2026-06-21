import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://budpfteibhmphgyagcs.supabase.co";
const supabaseAnonKey = "sb_publishable_4Is-dFQMf1SQEgizreCuiA_4fs2-TE0";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
