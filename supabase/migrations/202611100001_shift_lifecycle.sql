-- Existing rows represent historical closed cash reconciliations.
ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'closed',
  ADD COLUMN IF NOT EXISTS start_time timestamptz,
  ADD COLUMN IF NOT EXISTS end_time timestamptz;
UPDATE public.shifts SET start_time = closed_at WHERE start_time IS NULL;
UPDATE public.shifts SET end_time = closed_at WHERE status = 'closed' AND end_time IS NULL;
ALTER TABLE public.shifts ALTER COLUMN start_time SET DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_store
  ON public.shifts (store_id) WHERE status = 'open';
