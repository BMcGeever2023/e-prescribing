-- ============================================================================
-- 0004_storage.sql — private bucket for prescriber ID documents
-- Stores the passport/licence uploaded at registration so a pharmacist can
-- review the real document before verifying the prescriber. The bucket is
-- PRIVATE — files are only reachable through short-lived signed URLs, and only
-- by the owner or a pharmacy account. Run AFTER 0003 (needs public.is_pharmacy()).
-- ============================================================================

-- Private bucket: 10 MB cap, images + PDF only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('prescriber-ids', 'prescriber-ids', false, 10485760,
        array['image/png','image/jpeg','image/jpg','application/pdf'])
on conflict (id) do nothing;

-- RLS is already enabled on storage.objects in Supabase; add scoped policies.
-- Objects live under a top-level folder named after the owner's user id:
--   prescriber-ids/{auth.uid()}/{timestamp}-{filename}

-- Upload: a prescriber may write only into their own folder.
drop policy if exists "prescriber_ids_insert_own" on storage.objects;
create policy "prescriber_ids_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'prescriber-ids'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Read: a prescriber may read their own document; pharmacy may read any of them.
drop policy if exists "prescriber_ids_select_own_or_pharmacy" on storage.objects;
create policy "prescriber_ids_select_own_or_pharmacy" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'prescriber-ids'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_pharmacy())
  );
