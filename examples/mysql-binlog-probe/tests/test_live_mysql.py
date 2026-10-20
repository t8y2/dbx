import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from live_mysql import finish_run


class LifecycleTest(unittest.TestCase):
    def test_failed_evidence_write_still_stops_owned_server_and_closes_logs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            socket_dir = root / "socket"
            socket_dir.mkdir()
            (socket_dir / "m.sock").touch()
            server = Mock()
            server.poll.side_effect = [None, 0]
            output = io.StringIO()
            with patch.object(Path, "write_text", side_effect=OSError("disk full")):
                with self.assertRaisesRegex(OSError, "disk full"):
                    finish_run(root, {}, server, output, socket_dir)
            server.terminate.assert_called_once()
            server.wait.assert_called_once_with(timeout=30)
            self.assertTrue(output.closed)
            self.assertFalse(socket_dir.exists())


if __name__ == "__main__":
    unittest.main()
