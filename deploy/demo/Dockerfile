# 演示镜像：在官方发布镜像上叠加首次启动播种逻辑与示例数据。
# 中国大陆可改用 CNB 镜像源：FROM docker.cnb.cool/dbxio.com/dbx:latest
FROM t8y2/dbx:latest

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

COPY seed/connections.json /seed/connections.json
COPY seed/entrypoint.sh /seed/entrypoint.sh
RUN chmod +x /seed/entrypoint.sh

ENTRYPOINT ["/seed/entrypoint.sh"]
