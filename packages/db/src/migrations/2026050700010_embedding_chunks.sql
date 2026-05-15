alter table memory_embeddings
  add column if not exists source_chunk_index integer not null default 0,
  add column if not exists source_chunk_count integer not null default 1,
  add column if not exists source_text text;

alter table memory_embeddings
  drop constraint if exists memory_embeddings_source_chunk_index_check;

alter table memory_embeddings
  add constraint memory_embeddings_source_chunk_index_check
  check (source_chunk_index >= 0);

alter table memory_embeddings
  drop constraint if exists memory_embeddings_source_chunk_count_check;

alter table memory_embeddings
  add constraint memory_embeddings_source_chunk_count_check
  check (source_chunk_count >= 1 and source_chunk_index < source_chunk_count);

drop index if exists memory_embeddings_unique_active_source;
drop index if exists memory_embeddings_unique_active_node_source;
drop index if exists memory_embeddings_unique_active_event_source;
drop index if exists memory_embeddings_unique_active_message_source;

create unique index if not exists memory_embeddings_unique_active_node_chunk
  on memory_embeddings(memory_node_id, embedding_model, embedding_dimensions, embedding_version, source_hash, source_chunk_index)
  where invalidated_at is null and memory_node_id is not null;

create unique index if not exists memory_embeddings_unique_active_event_chunk
  on memory_embeddings(memory_event_id, embedding_model, embedding_dimensions, embedding_version, source_hash, source_chunk_index)
  where invalidated_at is null and memory_event_id is not null;

create unique index if not exists memory_embeddings_unique_active_message_chunk
  on memory_embeddings(message_id, embedding_model, embedding_dimensions, embedding_version, source_hash, source_chunk_index)
  where invalidated_at is null and message_id is not null;
