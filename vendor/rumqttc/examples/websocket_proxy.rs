use rumqttc::{AsyncClient, Proxy, ProxyAuth, ProxyType, QoS, Transport};
use std::{error::Error, time::Duration};
use tokio::{task, time};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn Error>> {
    use rumqttc::MqttOptions;

    pretty_env_logger::init();

    // port parameter is ignored when scheme is websocket
    let mut mqttoptions = MqttOptions::new(
        "clientId-aSziq39Bp3",
        "ws://broker.mqttdashboard.com:8000/mqtt",
        8000,
    );
    mqttoptions.set_transport(Transport::Ws);
    mqttoptions.set_keep_alive(Duration::from_secs(60));
    // Presumes that there is a proxy server already set up listening on 127.0.0.1:8100
    mqttoptions.set_proxy(Proxy {
        ty: ProxyType::Http,
        auth: ProxyAuth::None,
        addr: "127.0.0.1".into(),
        port: 8100,
    });

    let (client, mut eventloop) = AsyncClient::new(mqttoptions, 10);
    task::spawn(async move {
        requests(client).await;
        time::sleep(Duration::from_secs(3)).await;
    });

    loop {
        let event = eventloop.poll().await;
        match event {
            Ok(notif) => {
                println!("Event = {notif:?}");
            }
            Err(err) => {
                println!("Error = {err:?}");
                return Ok(());
            }
        }
    }
}

async fn requests(client: AsyncClient) {
    client
        .subscribe("hello/world", QoS::AtMostOnce)
        .await
        .unwrap();

    for i in 1..=10 {
        client
            .publish("hello/world", QoS::ExactlyOnce, false, vec![1; i])
            .await
            .unwrap();

        time::sleep(Duration::from_secs(1)).await;
    }

    time::sleep(Duration::from_secs(120)).await;
}
