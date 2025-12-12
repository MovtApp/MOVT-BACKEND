**Graph Design & API**

- **Propósito:** modelar a rede de seguidores como um grafo (Property Graph) para operações rápidas de vizinhança, caminho mínimo, recomendações e análises sociais.

- **Nós (Vertices):** `usuarios` — cada nó representa um usuário. Propriedades mínimas: `id_us`, `nome`, `username`, `email`, `avatar_url`, `role`.

- **Arestas (Edges):** `follows` — cada registro representa um relacionamento de seguimento do tipo SEGUE: `follower_user_id -> trainer_id`.
  - Colunas recomendadas: `id`, `follower_user_id`, `trainer_id`, `created_at`.
  - Índices: `follower_user_id`, `trainer_id`, e constraint UNIQUE (`follower_user_id`, `trainer_id`).

API implementada (REST)
- `GET /api/graph/network` (autenticado)
  - Query params:
    - `userId` (opcional): id da raiz; se ausente, usa o usuário da sessão
    - `depth` (opcional): profundidade (default=2, max=5)
    - `maxNodes` (opcional): limite de nós (default=500, max=2000)
    - `direction` (opcional): `out` (quem o usuário segue), `in` (quem segue o usuário), `both` (padrão)
  - Resposta: JSON `{ nodes: [...], links: [...], meta: { requestedFor, depth, countNodes, countEdges } }`
  - Observações: implementado com CTE recursivo no Postgres sobre a tabela `follows`.

Migração SQL
- Arquivo: `migrations/001_create_follows.sql` (adiciona tabela e índices). Execute em Supabase ou no seu Postgres:

  ```sql
  -- copie o conteúdo de migrations/001_create_follows.sql e execute no SQL editor do Supabase
  ```

Exemplos de uso (curl)
- Lista subgrafo (usuário atual, profundidade 2):

  ```bash
  curl -H "Authorization: Bearer <SESSION_ID>" "http://localhost:3000/api/graph/network?depth=2&maxNodes=500"
  ```

Recomendações de arquitetura e escala
- Para poucas dezenas de milhares de usuários a combinação Postgres + tabela `follows` com índices é suficiente.
- Para redes maiores (milhões de nós/arestas) ou consultas de grafo complexas (k-core, PageRank, caminhos repetidos): considere um banco de dados de grafos dedicado (Neo4j, Amazon Neptune, TigerGraph).
- Caching: use cache por usuário (Redis) para subgrafos ou métricas que mudam com menor frequência.
- Particionamento e sharding: quando o volume de arestas explodir, considere particionar por intervalo ou pela origem do follower.

Exemplo Cypher (Neo4j) equivalente

  MATCH (u:User {id: 123})
  CALL apoc.path.subgraphNodes(u, {maxLevel:2}) YIELD node
  RETURN node

Práticas de segurança e regras de negócio
- Validar todas as operações no backend (bloqueios, limites por minuto, evitar auto-follow, checar bans)
- Notificações: quando um follow acontece, insira um registro em `notifications` e envie push/real-time se necessário.

Observações finais
- O endpoint implementado fornece uma visão em formato grafo (nós + arestas) pronta para frontends e vis.js/d3.js. Para análises mais profundas ou recomendações em larga escala, prefira bancos de grafos/serviços especializados.
