create extension if not exists vector;

alter table memory_embeddings
  drop constraint if exists memory_embeddings_embedding_dimensions_check;

alter table memory_embeddings
  add constraint memory_embeddings_embedding_dimensions_check
  check (embedding_dimensions in (384, 1024, 1536, 3072));

create table if not exists memory_embeddings_1024 (
  memory_embedding_id uuid primary key references memory_embeddings(id) on delete cascade,
  embedding vector(1024) not null
);

create index if not exists memory_embeddings_1024_hnsw_idx
  on memory_embeddings_1024 using hnsw (embedding vector_cosine_ops);
