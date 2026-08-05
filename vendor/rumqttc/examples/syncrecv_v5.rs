use rumqttc::v5::mqttbytes::{v5::LastWill, QoS};
use rumqttc::v5::{Client, MqttOptions};
use std::thread;
use std::time::Duration;

fn main() {
    pretty_env_logger::init();

    let mut mqttoptions = MqttOptions::new("test-1", "localhost", 1884);
    let will = LastWill::new("hello/world", "good bye", QoS::AtMostOnce, false, None);
    mqttoptions
        .set_keep_alive(Duration::from_secs(5))
        .set_last_will(will);

    let (client, mut connection) = Client::new(mqttoptions, 10);
    thread::spawn(move || publish(client));

    if let Ok(notification) = connection.recv() {
        println!("Notification = {notification:?}");
    }

    if let Ok(notification) = connection.try_recv() {
        println!("Notification = {notification:?}");
    }

    if let Ok(notification) = connection.recv_timeout(Duration::from_secs(10)) {
        println!("Notification = {notification:?}");
    }
}

fn publish(client: Client) {
    client.subscribe("hello/+/world", QoS::AtMostOnce).unwrap();
    for i in 0..3 {
        let payload = vec![1; i];
        let topic = format!("hello/{i}/world");
        let qos = QoS::AtLeastOnce;

        client.publish(topic, qos, true, payload).unwrap();
    }

    thread::sleep(Duration::from_secs(1));
}
