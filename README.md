# Rota Roda — Roteirizador VRP (Trabalho Final)

**Tópicos Especiais em Engenharia de Produção (Roteamento) · UFF**

Aplicação web que resolve problemas de roteamento de veículos a partir de endereços reais e
desenha as rotas no mapa. O cálculo é **exato**, feito com o
[VRPSolverEasy](https://github.com/inria-UFF/VRPSolverEasy) (branch-cut-and-price).

**Custo: R$ 0.** Por padrão, tudo roda com serviços gratuitos do OpenStreetMap, sem chave e sem cartão.
O Google Maps é opcional.

| Etapa | O que acontece |
|---|---|
| **1. Pontos** | Busca de endereço com sugestões enquanto digita, clique no mapa ou importação de planilha. Os marcadores podem ser arrastados para ajustar a posição. |
| **2. Frota** | Tipos de veículo com capacidade, quantidade, custo/km, custo fixo e depósito de origem. |
| **3. Rotas** | Matriz de distâncias pelas ruas → Clarke & Wright → VRPSolverEasy. Rotas no mapa com setas de sentido, indicadores, horários previstos, links de navegação e exportação para Excel. |

## Diferenciais em relação ao exemplo da disciplina

- **Distâncias e tempos reais pelas ruas**, com matriz **assimétrica**: ida e volta podem ter distâncias diferentes, por causa de contramão.
- **Variantes suportadas:**
  - frota heterogênea, com custo fixo;
  - múltiplos depósitos;
  - janelas de tempo com tempo de atendimento (VRPTW);
  - rotas abertas, em que o veículo não volta ao depósito.
- **Comparação exato × heurística:** o Clarke & Wright roda antes e cumpre dois papéis:
  - mostra o **gap %** da heurística em relação ao ótimo;
  - entra como **limite superior** para o branch-cut-and-price.
- **Sugestões de endereço enquanto digita**, que evitam erros de geocodificação.
- **"Abrir no Google Maps"** em cada rota, com navegação pronta para o motorista. Esses links são gratuitos e não precisam de chave.
- **Exportação para Excel** (resumo, custos por rota e sequência com horários).
- **Degradação segura:** se um serviço de mapa cair, o app continua funcionando e a tela informa a fonte usada.

## Serviços usados (todos gratuitos por padrão)

| Função | Modo gratuito (padrão) | Com Google (opcional) |
|---|---|---|
| Mapa | Leaflet + OpenStreetMap (estilo CARTO Voyager) | Google Maps JavaScript API |
| Sugestões de endereço | Photon (OpenStreetMap) | Places API (New) |
| Endereço → coordenada | Nominatim (OpenStreetMap) | Geocoding API |
| Distâncias, tempos e traçado das rotas | OSRM (OpenStreetMap) | Routes API |
| Hospedagem | Render, plano Free (sem cartão) | — |

Os serviços públicos do OpenStreetMap são gratuitos para uso leve, como um trabalho acadêmico. Se o OSRM
estiver fora do ar, o app estima as distâncias por linha reta × 1,35 e avisa na tela.

## Arquitetura

```
navegador (HTML/CSS/JS + Leaflet/OpenStreetMap  ou  Google Maps)
        │  POST /api/solve  (pontos, frota, opções)
        ▼
FastAPI (Python) ──► OSRM (grátis) ou Google Routes: matriz de distâncias/tempos + traçado
        │
        ├─► Clarke & Wright (savings paralelo)  → limite superior + comparação
        └─► VRPSolverEasy 0.1.3 (BaPCod + CLP)  → solução ótima
```

```
app/
  main.py        API (config, suggest, reverse, geocode, solve) + serve o front-end
  solver.py      modelagem VRPSolverEasy, Clarke & Wright, avaliação de rotas
  geo.py         OpenStreetMap (Photon, Nominatim, OSRM) e Google, com fallbacks
  static/        index.html, styles.css, app.js + vendor/ (Leaflet e SheetJS locais)
tests/           21 testes (inclui conferência do ótimo por força bruta)
Dockerfile, render.yaml, requirements.txt
```

> **Atenção à versão do solver.** O `VRPSolverEasy==0.1.4` (a mais recente no PyPI) **não traz
> mais o solver compilado**: ele pede para baixar o BaPCod à parte. A **0.1.3** ainda inclui o BaPCod + CLP,
> por isso ela está fixada no `requirements.txt`.

## Rodar no computador

**Windows (mais fácil):** dê dois cliques em **`INICIAR.bat`**. Na primeira vez ele prepara tudo, o que leva
de 1 a 3 minutos; depois abre o app no navegador em http://localhost:8000. Se o Python não estiver instalado,
o próprio arquivo abre a página de download: instale a versão 3.11 ou 3.12 marcando **"Add python.exe to PATH"**.

**Manual (qualquer sistema):**

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate    |  Linux/Mac: source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload
```

Abra http://localhost:8000. Não precisa de `.env` nem de chave. Para rodar os testes: `python -m pytest -q`.

O VRPSolverEasy tem binários para Windows 64 bits, Linux e macOS Intel. No Mac com chip M1/M2/M3, rode via Docker.

## Publicar de graça (link para enviar ao professor)

1. Crie uma conta gratuita no [GitHub](https://github.com) e suba esta pasta para um repositório.
2. Crie uma conta gratuita no [Render](https://render.com), entrando com o GitHub. **Não pede cartão.**
3. No Render: **New + → Blueprint** → escolha o repositório. O `render.yaml` já configura tudo no plano Free.
4. Quando o deploy terminar, o link fica no formato `https://rota-roda-uff.onrender.com`.

**Limites do plano Free do Render:**
- o app "adormece" após 15 min sem uso, e o primeiro acesso depois disso leva cerca de 1 minuto;
- são 750 horas grátis por mês, o que é suficiente para um app só.

Abra o link um pouco antes de o professor acessar.

## Google Maps (opcional)

Só vale a pena se você quiser o visual do Google. **O Google exige cadastrar um cartão** na conta de faturamento,
mesmo que o uso de um trabalho de aula fique dentro da cota gratuita mensal. Se quiser ativar:

1. No [Google Cloud Console](https://console.cloud.google.com/), crie um projeto e ative o faturamento.
2. Ative estas APIs:
   - Maps JavaScript API
   - Places API (New)
   - Geocoding API
   - Routes API
3. Crie as variáveis de ambiente, copiando o `.env.example` para `.env` localmente e cadastrando-as no Render em *Environment*:
   - `GOOGLE_MAPS_BROWSER_KEY`: restrinja a chave aos sites `http://localhost:8000/*` e `https://SEU-APP.onrender.com/*`;
   - `GOOGLE_MAPS_SERVER_KEY`: restrinja à Routes API e à Geocoding API.
4. Crie um alerta de orçamento (ex.: R$ 10).

Com a chave do navegador, o app usa o Google Maps. Sem ela, volta sozinho para o OpenStreetMap.

## Planilha de importação

Use o botão **Modelo .xlsx** no app. A primeira aba é lida, e os nomes das colunas não diferenciam
maiúsculas nem acentos.

| Coluna | Obrigatória | Exemplo |
|---|---|---|
| `endereco` | sim (ou `lat` + `lng`) | Rua da Conceição, 100, Centro, Niterói, RJ |
| `demanda` | sim para clientes | 80 |
| `deposito` | não (padrão: 1ª linha) | sim |
| `nome` | não | Loja Centro |
| `inicio` / `fim` | não (ativam janelas de tempo) | 09:00 / 12:00 |
| `servico` | não (minutos, padrão 5) | 10 |

## Método

- **Exato:** o VRPSolverEasy modela o problema como *Rich VRP* e resolve por **branch-cut-and-price**
  (geração de colunas com relaxação *ng-route*, cortes de capacidade, fixação por custo reduzido,
  enumeração de rotas e branching),
  usando o BaPCod com o CLP. A tela mostra se a otimalidade foi **provada**
  (limite inferior = custo) ou se o tempo limite foi atingido.
- **Heurística:** Clarke & Wright paralelo, respeitando o sentido dos arcos (matriz assimétrica),
  a capacidade e as janelas de tempo. As rotas são depois atribuídas aos veículos mais baratos que
  as comportam. Em mais de um depósito, cada cliente vai para o depósito mais próximo.
- **Rotas abertas:** os arcos cliente → depósito recebem custo e tempo zero. É a modelagem usual
  para *open VRP*, porque o `end_point_id=-1` da biblioteca não funcionou nos testes.
- **Validação:** em instâncias pequenas, o custo ótimo é conferido contra enumeração completa
  (permutação + *split* ótimo) em `tests/test_solver.py`.
