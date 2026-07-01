from __future__ import annotations

import asyncio
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import sys
import time
from typing import Any

from pymammotion.client import MammotionClient
from pymammotion.data.model.device_config import OperationSettings, create_path_order
from pymammotion.data.model.enums import RTKStatus
from pymammotion.data.model.generate_route_information import GenerateRouteInformation
from pymammotion.http.http import MammotionHTTP
from pymammotion.proto import RptAct, RptInfoType
from pymammotion.transport.base import AuthError, LoginFailedError, ReLoginRequiredError, SessionExpiredError
from pymammotion.utility.constant.device_constant import PosType, device_connection, device_mode
from pymammotion.utility.device_config import DeviceConfig
from pymammotion.utility.device_type import DeviceType


class JsonRpcError(Exception):
    def __init__(self, message: str, code: int = -32000) -> None:
        super().__init__(message)
        self.code = code


class Sidecar:
    def __init__(self) -> None:
        self.client: MammotionClient | None = None
        self.cache_path: Path | None = None
        self.account: str = ""
        self.password: str = ""
        self.log_level = "info"
        self.version = "0.1.0"
        self.error_catalog: dict[str, Any] = {}
        self.device_config = DeviceConfig()
        self._state_subscriptions: list[Any] = []
        self._ready_emitted = False
        self._last_snapshot_at = 0.0
        self._last_snapshot_iso = ""
        self._area_name_sync_inflight: set[str] = set()
        self._area_name_sync_signatures: dict[str, str] = {}

    async def emit(self, method: str, params: dict[str, Any] | None = None) -> None:
        payload = {"method": method}
        if params is not None:
            payload["params"] = self.make_json_compatible(params)
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()

    async def respond(self, id_: int, result: dict[str, Any] | None = None, error: JsonRpcError | None = None) -> None:
        payload: dict[str, Any] = {"id": id_}
        if error is not None:
            payload["error"] = {"code": error.code, "message": str(error)}
        else:
            payload["result"] = self.make_json_compatible(result or {})
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()

    async def log(self, level: str, message: str) -> None:
        await self.emit("log", {"level": level, "message": message})

    async def handle_request(self, request: dict[str, Any]) -> None:
        request_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        try:
            if method == "health":
                await self.respond(
                    request_id,
                    {
                        "ok": True,
                        "python_version": sys.version.split()[0],
                        "authenticated": self.client is not None,
                        "last_snapshot_at": self._last_snapshot_iso,
                    },
                )
            elif method == "validate_connection":
                result = await self.validate_connection(params)
                await self.respond(request_id, result)
            elif method == "bootstrap":
                self.log_level = params.get("sidecar_log_level", "info")
                self.version = str(params.get("adapter_version") or self.version)
                if not self._ready_emitted:
                    self._ready_emitted = True
                    await self.emit("ready", {"version": self.version})
                await self.respond(request_id, {"adapter": "mammotion-pymammotion", "version": self.version})
            elif method == "login_or_restore":
                result = await self.login_or_restore(params)
                await self.respond(request_id, result)
            elif method == "diagnostic_login":
                result = await self.diagnostic_login(params)
                await self.respond(request_id, result)
            elif method == "list_devices":
                await self.respond(request_id, {"devices": self.list_device_names()})
            elif method == "get_snapshot":
                device_id = params.get("device_id")
                await self.respond(request_id, {"snapshot": self.get_snapshot(device_id)})
            elif method == "send_command":
                result = await self.send_command(params["device_id"], params["command"])
                await self.respond(request_id, result)
            elif method == "set_setting":
                result = await self.set_setting(params["device_id"], params["key"], params.get("value"))
                await self.respond(request_id, result)
            elif method == "zone_action":
                result = await self.zone_action(params["device_id"], params["action"])
                await self.respond(request_id, result)
            elif method == "plan_action":
                result = await self.plan_action(params["device_id"], params["action"], params.get("plan_id"))
                await self.respond(request_id, result)
            elif method == "start_areas":
                result = await self.start_areas(
                    params["device_id"],
                    params.get("area_hashes") or [],
                    params.get("overrides") or {},
                    bool(params.get("start_immediately", True)),
                )
                await self.respond(request_id, result)
            elif method == "shutdown":
                await self.shutdown()
                await self.respond(request_id, {"stopped": True})
                raise EOFError
            else:
                raise JsonRpcError(f"Unknown method: {method}", -32601)
        except EOFError:
            raise
        except JsonRpcError as error:
            await self.respond(request_id, error=error)
        except Exception as error:  # noqa: BLE001
            await self.emit("error", {"message": str(error)})
            await self.respond(request_id, error=JsonRpcError(str(error)))

    async def login_or_restore(self, params: dict[str, Any]) -> dict[str, Any]:
        self.account = params["account"]
        self.password = params["password"]
        self.cache_path = Path(params["cache_path"])
        await self.teardown_client()
        self.client = MammotionClient(ha_version=self.version)
        self.client.on_unrecoverable_auth_error = self.on_unrecoverable_auth_error
        self.client.on_credentials_updated = self.on_credentials_updated

        used_cache = False
        cache_data: dict[str, Any] = {}
        if self.cache_path.exists():
            try:
                cache_data = json.loads(self.cache_path.read_text("utf8"))
            except Exception:  # noqa: BLE001
                cache_data = {}

        if cache_data:
            try:
                await self.client.restore_credentials(self.account, self.password, cache_data)
                used_cache = True
            except Exception as error:  # noqa: BLE001
                await self.log("warning", f"Credential restore failed, falling back to login: {error}")
                await self.client.login_and_initiate_cloud(self.account, self.password)
        else:
            await self.client.login_and_initiate_cloud(self.account, self.password)

        await self.load_error_catalog()
        await self.register_device_watchers()
        await self.prime_device_state()
        await self.persist_cache()
        await self.emit("auth_state", {"authenticated": True, "message": "restored" if used_cache else "logged_in"})
        for device_id in self.list_device_names():
            snapshot = self.get_snapshot(device_id)
            if snapshot is None:
                continue
            await self.emit("device_discovered", {"device_id": device_id, "name": snapshot["name"]})
            await self.emit("device_snapshot", {"snapshot": snapshot})
        return {"authenticated": True, "devices": self.list_device_names()}

    async def validate_connection(self, params: dict[str, Any]) -> dict[str, Any]:
        if self.client is None:
            raise JsonRpcError("Client is not initialized")

        device_names = self.list_device_names()
        online_devices = 0
        for device_id in device_names:
            snapshot = self.get_snapshot(device_id)
            if snapshot and bool(snapshot["status"]["online"]):
                online_devices += 1

        result = {
            "ok": True,
            "authenticated": True,
            "device_count": len(device_names),
            "online_devices": online_devices,
            "probe": "none",
            "last_snapshot_at": self._last_snapshot_iso,
            "last_snapshot_age_sec": max(0.0, time.monotonic() - self._last_snapshot_at) if self._last_snapshot_at > 0 else -1.0,
        }

        if not bool(params.get("probe", True)):
            return result

        try:
            if self.client.cloud_gateway is not None:
                await self.client.cloud_gateway.check_or_refresh_session()
                await self.client.cloud_gateway.list_binding_by_account()
                result["probe"] = "aliyun:list_binding_by_account"
            elif self.client.mammotion_http is not None:
                await self.client.mammotion_http.get_user_device_list()
                result["probe"] = "mammotion:get_user_device_list"
            else:
                result["probe"] = "none"
            await self.persist_cache()
        except Exception as error:
            message = f"Connection validation failed: {error}"
            if self.is_auth_error(error):
                await self.emit("auth_state", {"authenticated": False, "message": message})
            raise JsonRpcError(message)

        return result

    async def on_unrecoverable_auth_error(self, account_id: str, transport_type: Any, exc: Exception) -> None:
        transport_name = getattr(transport_type, "value", str(transport_type))
        message = f"{transport_name} auth failed for {account_id}: {exc}"
        await self.log("warning", message)
        await self.emit("auth_state", {"authenticated": False, "message": message})
        await self.emit("error", {"message": message})

    async def on_credentials_updated(self) -> None:
        await self.persist_cache()
        await self.log("debug", "PyMammotion credentials updated; cache persisted")

    async def diagnostic_login(self, params: dict[str, Any]) -> dict[str, Any]:
        account = params["account"]
        password = params["password"]
        mammotion_http = MammotionHTTP(ha_version=self.version)
        response = await mammotion_http.login_v2(account, password)
        return {
            "ok": bool(response.code == 0),
            "code": int(response.code),
            "message": response.msg or "",
        }

    async def register_device_watchers(self) -> None:
        await self.clear_subscriptions()
        if self.client is None:
            return
        for device_id in self.list_device_names():
            handle = self.client.mower(device_id)
            if handle is None:
                continue

            async def on_state_changed(snapshot: Any, current_device_id: str = device_id) -> None:
                normalized = self.get_snapshot(current_device_id)
                if normalized is None:
                    return
                self.touch_snapshot_clock()
                await self.emit("device_snapshot", {"snapshot": normalized})
                await self.emit("device_online", {"device_id": current_device_id, "online": bool(normalized["status"]["online"])})

            self._state_subscriptions.append(handle.subscribe_state_changed(on_state_changed))

    async def clear_subscriptions(self) -> None:
        for subscription in self._state_subscriptions:
            try:
                subscription.cancel()
            except Exception:  # noqa: BLE001
                pass
        self._state_subscriptions.clear()

    async def load_error_catalog(self) -> None:
        self.error_catalog = {}
        if self.client is None:
            return
        mammotion_http = getattr(self.client, "cloud_http", None)
        if mammotion_http is None:
            return
        try:
            self.error_catalog = await mammotion_http.get_all_error_codes()
        except Exception as error:  # noqa: BLE001
            await self.log("warning", f"Failed to load Mammotion error catalog: {error}")

    async def prime_device_state(self) -> None:
        if self.client is None:
            return

        for device_id in self.list_device_names():
            device = self.client.get_device_by_name(device_id)
            if device is None:
                continue
            product_key = self.get_product_key(device)
            if DeviceType.is_rtk(device_id, product_key) or DeviceType.is_swimming_pool(device_id):
                continue

            for command in ("get_error_code", "get_error_timestamp", "get_report_cfg", "get_maintenance"):
                try:
                    await self.client.send_command_with_args(device_id, command)
                except Exception as error:  # noqa: BLE001
                    await self.log("debug", f"Initial device refresh command {command} failed for {device_id}: {error}")

        await asyncio.sleep(2)

    def make_json_compatible(self, value: Any) -> Any:
        if value is None or isinstance(value, str | int | float | bool):
            return value
        if isinstance(value, dict):
            return {str(key): self.make_json_compatible(entry) for key, entry in value.items()}
        if isinstance(value, list | tuple | set):
            return [self.make_json_compatible(entry) for entry in value]
        if is_dataclass(value):
            return self.make_json_compatible(asdict(value))
        to_dict = getattr(value, "to_dict", None)
        if callable(to_dict):
            return self.make_json_compatible(to_dict())
        if hasattr(value, "__dict__"):
            return self.make_json_compatible(vars(value))
        return str(value)

    async def persist_cache(self) -> None:
        if self.client is None or self.cache_path is None:
            return
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        serialized_cache = self.make_json_compatible(self.client.to_cache())
        self.cache_path.write_text(json.dumps(serialized_cache), "utf8")

    def touch_snapshot_clock(self) -> None:
        self._last_snapshot_at = time.monotonic()
        self._last_snapshot_iso = datetime.now(timezone.utc).isoformat()

    @staticmethod
    def is_auth_error(error: Exception) -> bool:
        return isinstance(error, AuthError | ReLoginRequiredError | LoginFailedError | SessionExpiredError)

    @staticmethod
    def first_non_empty(*values: Any) -> Any:
        for value in values:
            if value not in (None, "", [], {}, ()):
                return value
        return values[-1] if values else None

    @staticmethod
    def to_float(value: Any, default: float = 0.0) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def to_int(value: Any, default: int = 0) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def to_bool(value: Any, default: bool = False) -> bool:
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"1", "true", "yes", "on"}:
                return True
            if lowered in {"0", "false", "no", "off"}:
                return False
        return default

    @staticmethod
    def looks_like_geo_coordinate(latitude: float, longitude: float) -> bool:
        return -90.0 <= latitude <= 90.0 and -180.0 <= longitude <= 180.0

    def select_global_coordinates(self, location: Any, device: Any) -> tuple[float, float]:
        device_lat = self.to_float(getattr(getattr(location, "device", None), "latitude", 0.0))
        device_lon = self.to_float(getattr(getattr(location, "device", None), "longitude", 0.0))
        rtk_lat = self.to_float(getattr(getattr(location, "RTK", None), "latitude", 0.0) or getattr(device, "lat", 0.0))
        rtk_lon = self.to_float(getattr(getattr(location, "RTK", None), "longitude", 0.0) or getattr(device, "lon", 0.0))

        if self.looks_like_geo_coordinate(rtk_lat, rtk_lon):
            if not self.looks_like_geo_coordinate(device_lat, device_lon):
                return rtk_lat, rtk_lon
            if abs(device_lat - rtk_lat) > 0.01 or abs(device_lon - rtk_lon) > 0.01:
                return rtk_lat, rtk_lon

        if self.looks_like_geo_coordinate(device_lat, device_lon):
            return device_lat, device_lon
        return rtk_lat, rtk_lon

    async def emit_snapshot(self, device_id: str) -> None:
        snapshot = self.get_snapshot(device_id)
        if snapshot is not None:
            self.touch_snapshot_clock()
            await self.emit("device_snapshot", {"snapshot": snapshot})

    def area_names_need_sync(self, map_data: Any) -> bool:
        area_map = getattr(map_data, "area", {}) or {}
        if not area_map:
            return False

        current_names = list(getattr(map_data, "area_name", []) or [])
        if not current_names:
            return True

        sorted_hashes = sorted(self.to_int(hash_id, 0) for hash_id in area_map.keys() if self.to_int(hash_id, 0) > 0)
        if len(current_names) != len(sorted_hashes):
            return True

        fallback_names_by_hash = {hash_id: f"area {index}" for index, hash_id in enumerate(sorted_hashes, start=1)}
        for item in current_names:
            hash_id = self.to_int(getattr(item, "hash", 0), 0)
            name = str(getattr(item, "name", "") or "").strip()
            if hash_id <= 0 or not name:
                return True
            if fallback_names_by_hash.get(hash_id) != name:
                return False
        return True

    def area_name_sync_signature(self, map_data: Any) -> str:
        area_map = getattr(map_data, "area", {}) or {}
        hashes = sorted(self.to_int(hash_id, 0) for hash_id in area_map.keys() if self.to_int(hash_id, 0) > 0)
        return ",".join(str(hash_id) for hash_id in hashes)

    def schedule_area_name_sync_if_needed(self, device_id: str, product_key: str, map_data: Any) -> None:
        if self.client is None or map_data is None:
            return
        if DeviceType.is_luba1(device_id) or DeviceType.is_rtk(device_id, product_key) or DeviceType.is_swimming_pool(device_id):
            return
        if not self.area_names_need_sync(map_data):
            self._area_name_sync_signatures.pop(device_id, None)
            return

        signature = self.area_name_sync_signature(map_data)
        if not signature or device_id in self._area_name_sync_inflight:
            return
        if self._area_name_sync_signatures.get(device_id) == signature:
            return

        self._area_name_sync_signatures[device_id] = signature
        self._area_name_sync_inflight.add(device_id)
        asyncio.create_task(self._run_area_name_sync(device_id))

    async def _run_area_name_sync(self, device_id: str) -> None:
        try:
            if self.client is None:
                return
            await self.log("debug", f"Triggering explicit area-name sync for {device_id}")
            await self.client.start_area_name_sync(device_id)
            await self.persist_cache()
        except Exception as error:  # noqa: BLE001
            await self.log("debug", f"Explicit area-name sync failed for {device_id}: {error}")
        finally:
            self._area_name_sync_inflight.discard(device_id)

    def get_area_hashes(self, device: Any, requested_hashes: list[Any] | None = None) -> list[int]:
        map_data = getattr(device, "map", None)
        work = getattr(device, "work", None)
        requested = [
            self.to_int(entry, 0)
            for entry in (requested_hashes or [])
            if self.to_int(entry, 0) > 0
        ]
        if requested:
            return list(dict.fromkeys(requested))

        active = [self.to_int(hash_id, 0) for hash_id in getattr(work, "zone_hashs", []) if self.to_int(hash_id, 0) > 0]
        if active:
            return list(dict.fromkeys(active))

        area_map = getattr(map_data, "area", {}) or {}
        return sorted(self.to_int(hash_id, 0) for hash_id in area_map.keys() if self.to_int(hash_id, 0) > 0)

    def resolve_area_name(self, area_names: dict[int, str], hash_id: int) -> tuple[str, str]:
        explicit_name = str(area_names.get(hash_id, "")).strip()
        if explicit_name:
            return explicit_name, "map"
        return f"zone {hash_id}", "fallback"

    def resolve_public_device_limits(self, device: Any, product_key: str, *extra_keys: Any) -> Any:
        mower_state = getattr(device, "mower_state", None)
        candidate_keys: list[str] = []
        for value in (
            getattr(mower_state, "sub_model_id", ""),
            getattr(mower_state, "internal_model", ""),
            getattr(mower_state, "model", ""),
            *extra_keys,
            product_key,
        ):
            key = str(value or "").strip()
            if key and key not in candidate_keys:
                candidate_keys.append(key)

        for key in candidate_keys:
            if limits := self.device_config.get_working_parameters(key):
                return limits

        device_limits = getattr(device, "device_limits", None)
        if device_limits is not None:
            return device_limits
        return self.device_config.get_best_default(product_key)

    def build_route_information(self, device_id: str, device: Any, area_hashes: list[int], overrides: dict[str, Any]) -> GenerateRouteInformation:
        work = getattr(device, "work", None)
        mower_state = getattr(device, "mower_state", None)
        limits = self.resolve_public_device_limits(
            device,
            self.get_product_key(device),
            getattr(mower_state, "model", ""),
            getattr(mower_state, "internal_model", ""),
        )
        operation_settings = OperationSettings(
            job_mode=self.to_int(overrides.get("jobMode"), self.to_int(getattr(work, "job_mode", 4), 4)),
            job_version=self.to_int(overrides.get("jobVersion"), self.to_int(getattr(work, "job_ver", 0), 0)),
            job_id=self.to_int(overrides.get("jobId"), self.to_int(getattr(work, "job_id", 0), 0)),
            speed=self.to_float(
                overrides.get("workingSpeed", overrides.get("speed")),
                self.to_float(getattr(work, "speed", 0.0), self.to_float(getattr(mower_state, "travel_speed", 0.3), 0.3)),
            ),
            ultra_wave=self.to_int(overrides.get("ultraWave"), self.to_int(getattr(work, "ultra_wave", 2), 2)),
            channel_mode=self.to_int(overrides.get("channelMode"), self.to_int(getattr(work, "channel_mode", 0), 0)),
            channel_width=self.to_int(
                overrides.get("channelWidth", overrides.get("pathSpacing")),
                self.to_int(
                    getattr(work, "channel_width", 0),
                    self.to_int(getattr(getattr(limits, "path_spacing", None), "min", 25), 25),
                ),
            ),
            rain_tactics=self.to_int(overrides.get("rainTactics"), 0),
            blade_height=self.to_int(
                overrides.get("bladeHeight"),
                self.to_int(getattr(work, "knife_height", 0), self.to_int(getattr(getattr(limits, "blade_height", None), "min", 0), 0)),
            ),
            toward=self.to_int(overrides.get("toward"), self.to_int(getattr(work, "toward", 0), 0)),
            toward_included_angle=self.to_int(
                overrides.get("towardIncludedAngle"),
                self.to_int(getattr(work, "toward_included_angle", 0), 0),
            ),
            toward_mode=self.to_int(overrides.get("towardMode"), self.to_int(getattr(work, "toward_mode", 0), 0)),
            border_mode=self.to_int(overrides.get("borderMode", overrides.get("edgeMode")), self.to_int(getattr(work, "edge_mode", 1), 1)),
            obstacle_laps=self.to_int(overrides.get("obstacleLaps"), 1),
            mowing_laps=self.to_int(overrides.get("mowingLaps", overrides.get("edgeMode")), self.to_int(getattr(work, "edge_mode", 1), 1)),
            start_progress=self.to_int(overrides.get("startProgress"), 0),
            areas=area_hashes,
        )

        if DeviceType.is_yuka(device_id):
            operation_settings.blade_height = -10

        route_information = GenerateRouteInformation(
            one_hashs=list(area_hashes),
            rain_tactics=operation_settings.rain_tactics,
            speed=operation_settings.speed,
            ultra_wave=operation_settings.ultra_wave,
            toward=operation_settings.toward,
            toward_included_angle=operation_settings.toward_included_angle if operation_settings.channel_mode == 1 else 0,
            toward_mode=operation_settings.toward_mode,
            blade_height=operation_settings.blade_height,
            channel_mode=operation_settings.channel_mode,
            channel_width=operation_settings.channel_width,
            job_mode=operation_settings.job_mode,
            job_version=operation_settings.job_version,
            job_id=operation_settings.job_id,
            edge_mode=operation_settings.mowing_laps,
            path_order=create_path_order(operation_settings, device_id),
            obstacle_laps=operation_settings.obstacle_laps,
        )

        if DeviceType.is_luba1(device_id):
            route_information.toward_mode = 0
            route_information.toward_included_angle = 0

        return route_information

    def get_product_key(self, device: Any) -> str:
        mower_state = getattr(device, "mower_state", None)
        return str(getattr(mower_state, "product_key", "") or getattr(device, "product_key", "") or "")

    def get_device_type(self, device_id: str, product_key: str) -> DeviceType:
        return DeviceType.value_of_str(device_id, product_key)

    def format_error_timestamp(self, timestamp: Any) -> str:
        raw = self.to_int(timestamp, 0)
        if raw <= 0:
            return ""
        return datetime.fromtimestamp(raw, tz=timezone.utc).isoformat()

    def get_error_message(self, error_code: int) -> tuple[str, str]:
        if error_code == 0:
            return "", ""
        error_info = self.error_catalog.get(str(abs(error_code)))
        if error_info is None:
            return "", ""

        message = (
            getattr(error_info, "de_implication", "")
            or getattr(error_info, "en_implication", "")
            or getattr(error_info, "description", "")
            or ""
        )
        solution = getattr(error_info, "de_solution", "") or getattr(error_info, "en_solution", "") or ""
        return str(message), str(solution)

    def list_device_names(self) -> list[str]:
        if self.client is None:
            return []
        registry = getattr(self.client, "_device_registry", None)
        if registry is None:
            return []
        return sorted(handle.device_name for handle in registry.all_devices)

    def get_snapshot(self, device_id: str | None) -> dict[str, Any] | None:
        if self.client is None or not device_id:
            return None
        handle = self.client.mower(device_id)
        device = self.client.get_device_by_name(device_id)
        if handle is None or device is None:
            return None

        snapshot = handle.snapshot
        raw_snapshot = getattr(snapshot, "raw", None)
        mower_state = getattr(device, "mower_state", None)
        device_firmwares = getattr(device, "device_firmwares", None)
        location = getattr(device, "location", None)
        report_data = getattr(device, "report_data", None)
        connect = getattr(report_data, "connect", None)
        work = getattr(report_data, "work", None)
        maintain = getattr(report_data, "maintain", None)
        rtk = getattr(report_data, "rtk", None)
        dev = getattr(report_data, "dev", None)
        errors = getattr(device, "errors", None)
        non_work_hours = getattr(device, "non_work_hours", None)
        map_data = getattr(device, "map", None)
        product_key = self.get_product_key(device)
        device_type = self.get_device_type(device_id, product_key)
        self.schedule_area_name_sync_if_needed(device_id, product_key, map_data)

        firmware = getattr(mower_state, "swversion", "") or getattr(device_firmwares, "device_version", "") or getattr(
            device,
            "device_version",
            "",
        )
        model = getattr(mower_state, "model", "") or getattr(mower_state, "internal_model", "") or getattr(
            device_firmwares,
            "model_name",
            "",
        )
        if not model:
            model = device_type.get_model()
        serial_number = getattr(mower_state, "wifi_mac", "") or getattr(device, "wifi_mac", "") or ""
        mqtt_transport = "cloud_mammotion" if product_key and "Y" not in product_key else "cloud"
        state_code = getattr(dev, "sys_status", 0) or getattr(device, "rtk_status", 0) or getattr(device, "basestation_status", 0)
        connection_state = getattr(snapshot.connection_state, "value", str(snapshot.connection_state))
        blade_height = getattr(getattr(raw_snapshot, "work", None), "knife_height", 0) or getattr(
            getattr(getattr(raw_snapshot, "report_data", None), "work", None),
            "knife_height",
            0,
        )
        activity = device_mode(self.to_int(state_code, 0))
        charge_state = self.to_int(getattr(dev, "charge_state", 0), 0)
        battery_level = self.to_int(self.first_non_empty(getattr(dev, "battery_val", None), snapshot.battery_level, 0), 0)
        error_codes = list(getattr(errors, "err_code_list", []) or [])
        error_times = list(getattr(errors, "err_code_list_time", []) or [])
        selected_zone_hashes = [self.to_int(hash_id, 0) for hash_id in getattr(work, "zone_hashs", []) if self.to_int(hash_id, 0) > 0]
        last_error_code = self.to_int(error_codes[0], 0) if error_codes else 0
        last_error_time = error_times[0] if error_times else 0
        last_error_message, last_error_solution = self.get_error_message(last_error_code)
        global_latitude, global_longitude = self.select_global_coordinates(location, device)
        current_work_zone = self.to_int(getattr(location, "work_zone", 0), 0)
        raw_location_latitude = self.to_float(getattr(getattr(location, "device", None), "latitude", 0.0))
        raw_location_longitude = self.to_float(getattr(getattr(location, "device", None), "longitude", 0.0))
        rtk_latitude = self.to_float(getattr(getattr(location, "RTK", None), "latitude", 0.0) or getattr(device, "lat", 0.0))
        rtk_longitude = self.to_float(getattr(getattr(location, "RTK", None), "longitude", 0.0) or getattr(device, "lon", 0.0))
        device_limits = self.resolve_public_device_limits(device, product_key, model)
        path_order_settings = GenerateRouteInformation.decode_path_order(str(getattr(work, "reserved", "") or ""))
        area_names = {
            self.to_int(item.hash, 0): str(item.name)
            for item in getattr(map_data, "area_name", []) or []
            if self.to_int(getattr(item, "hash", 0), 0) > 0
        }
        known_area_hashes = sorted(
            {
                self.to_int(hash_id, 0)
                for hash_id in (
                    list(getattr(getattr(map_data, "area", {}), "keys", lambda: [])())
                    + list(selected_zone_hashes)
                    + ([current_work_zone] if current_work_zone > 0 else [])
                )
                if self.to_int(hash_id, 0) > 0
            }
        )
        zones = []
        for hash_id in known_area_hashes:
            zone_name, zone_name_source = self.resolve_area_name(area_names, hash_id)
            zones.append(
                {
                    "hash": hash_id,
                    "name": zone_name,
                    "nameSource": zone_name_source,
                    "order": selected_zone_hashes.index(hash_id) + 1 if hash_id in selected_zone_hashes else 0,
                    "selected": hash_id in selected_zone_hashes,
                    "active": hash_id == current_work_zone,
                }
            )
        zone_names_by_hash = {int(zone["hash"]): str(zone["name"]) for zone in zones}
        current_work_zone_name = zone_names_by_hash.get(current_work_zone, area_names.get(current_work_zone, ""))

        telemetry = {
            "batteryLevel": battery_level,
            "bladeHeight": self.to_int(blade_height, 0),
            "latitude": global_latitude,
            "longitude": global_longitude,
            "workZone": current_work_zone,
            "workZoneName": current_work_zone_name,
            "wifiRssi": self.to_int(getattr(connect, "wifi_rssi", 0) or getattr(device, "wifi_rssi", 0), 0),
            "stateCode": state_code,
            "rtkLatitude": rtk_latitude,
            "rtkLongitude": rtk_longitude,
        }
        capabilities = {
            "isMower": not DeviceType.is_rtk(device_id, product_key) and not DeviceType.is_swimming_pool(device_id),
            "isRtk": DeviceType.is_rtk(device_id, product_key),
            "isLuba1": DeviceType.is_luba1(device_id, product_key),
            "isLubaPro": DeviceType.is_luba_pro(device_id, product_key),
            "isYuka": DeviceType.is_yuka(device_id),
            "has4g": DeviceType.has_4g(device_id, product_key),
            "hasZones": not DeviceType.is_rtk(device_id, product_key) and not DeviceType.is_swimming_pool(device_id),
            "hasEmergencyNudge": not DeviceType.is_rtk(device_id, product_key) and not DeviceType.is_swimming_pool(device_id),
            "hasBladeToggle": DeviceType.is_luba1(device_id, product_key),
            "hasBluetoothToggle": not DeviceType.is_rtk(device_id, product_key),
            "hasCloudToggle": not DeviceType.is_rtk(device_id, product_key),
            "hasSettings": not DeviceType.is_rtk(device_id, product_key),
            "hasRtk": not DeviceType.is_swimming_pool(device_id),
            "hasWorkAreaSelection": not DeviceType.is_rtk(device_id, product_key) and not DeviceType.is_swimming_pool(device_id),
        }
        diagnostics = {
            "batteryPercent": battery_level,
            "chargeState": charge_state,
            "systemStatus": self.to_int(state_code, 0),
            "systemStatusText": activity,
            "lastStatus": self.to_int(getattr(dev, "last_status", 0), 0),
            "vslamStatus": self.to_int(getattr(dev, "vslam_status", 0), 0),
            "progress": self.to_int(getattr(work, "progress", 0), 0),
            "workArea": self.to_int(getattr(work, "area", 0), 0),
            "path": self.to_int(getattr(work, "path", 0), 0),
            "pathHash": self.to_int(getattr(work, "path_hash", 0), 0),
            "pathSpacingHeight": self.to_int(getattr(work, "knife_height", 0), 0),
            "navRunMode": self.to_int(getattr(work, "nav_run_mode", 0), 0),
            "locationLatitude": raw_location_latitude,
            "locationLongitude": raw_location_longitude,
            "locationYaw": self.to_float(getattr(getattr(location, "device", None), "yaw", 0.0)),
            "globalLatitude": global_latitude,
            "globalLongitude": global_longitude,
            "rtkLatitude": rtk_latitude,
            "rtkLongitude": rtk_longitude,
            "positionType": str(PosType(self.to_int(getattr(location, "position_type", 0), 0)).name)
            if self.to_int(getattr(location, "position_type", 0), 0) in {item.value for item in PosType}
            else str(self.to_int(getattr(location, "position_type", 0), 0)),
            "workZone": current_work_zone,
            "workZoneName": current_work_zone_name,
            "connectionType": self.to_int(getattr(connect, "connect_type", 0), 0),
            "connectionTypeText": device_connection(connect) if connect is not None else "None",
            "usedNet": str(getattr(connect, "used_net", "NONE") or "NONE"),
            "wifiRssi": self.to_int(getattr(connect, "wifi_rssi", 0) or getattr(device, "wifi_rssi", 0), 0),
            "bleRssi": self.to_int(getattr(connect, "ble_rssi", 0), 0),
            "mobileRssi": self.to_int(getattr(connect, "mnet_rssi", 0), 0),
            "rtkStatus": str(RTKStatus.from_value(self.to_int(getattr(rtk, "status", 0), 0))),
            "rtkPositionLevel": self.to_int(getattr(rtk, "pos_level", 0), 0),
            "rtkSatellites": self.to_int(getattr(rtk, "gps_stars", 0), 0),
            "rtkL2Satellites": self.to_int(getattr(rtk, "l2_stars", 0), 0),
            "rtkCoViewL1": self.to_int(getattr(rtk, "co_view_stars", 0), 0) & 255,
            "rtkCoViewL2": (self.to_int(getattr(rtk, "co_view_stars", 0), 0) >> 8) & 255,
            "rtkAge": self.to_int(getattr(rtk, "age", 0), 0),
            "maintenanceWorkTime": self.to_int(getattr(maintain, "work_time", 0), 0),
            "maintenanceMileage": self.to_int(getattr(maintain, "mileage", 0), 0),
            "maintenanceBatteryCycles": self.to_int(getattr(maintain, "bat_cycles", 0), 0),
            "bladeUsedTime": self.to_int(getattr(getattr(maintain, "blade_used_time", None), "blade_used_time", 0), 0),
            "bladeWarnTime": self.to_int(getattr(getattr(maintain, "blade_used_time", None), "blade_used_warn_time", 0), 0),
            "quietHoursStart": str(getattr(non_work_hours, "start_time", "") or ""),
            "quietHoursEnd": str(getattr(non_work_hours, "end_time", "") or ""),
            "lastErrorCode": last_error_code,
            "lastErrorTimestamp": self.format_error_timestamp(last_error_time),
            "lastErrorMessage": last_error_message,
            "lastErrorSolution": last_error_solution,
            "errorCount": len(error_codes),
        }
        configuration = {
            "bladeHeight": self.to_int(getattr(work, "knife_height", 0), self.to_int(blade_height, 0)),
            "workingSpeed": self.to_float(getattr(work, "speed", 0.0), self.to_float(getattr(mower_state, "travel_speed", 0.0), 0.0)),
            "travelSpeed": self.to_float(getattr(mower_state, "travel_speed", 0.0), 0.0),
            "pathSpacing": self.to_int(getattr(work, "channel_width", 0), 0),
            "jobMode": self.to_int(getattr(work, "job_mode", 0), 0),
            "ultraWave": self.to_int(getattr(work, "ultra_wave", 0), 0),
            "channelMode": self.to_int(getattr(work, "channel_mode", 0), 0),
            "toward": self.to_int(getattr(work, "toward", 0), 0),
            "towardMode": self.to_int(getattr(work, "toward_mode", 0), 0),
            "towardIncludedAngle": self.to_int(getattr(work, "toward_included_angle", 0), 0),
            "edgeMode": self.to_int(getattr(work, "edge_mode", 0), 0),
            "borderMode": self.to_int(path_order_settings.edge_mode, 0),
            "obstacleLaps": self.to_int(path_order_settings.obstacle_laps, 0),
            "rainTactics": self.to_int(path_order_settings.rain_tactics, 0),
            "startProgress": self.to_int(path_order_settings.start_progress, 0),
            "collectGrassFrequency": self.to_int(path_order_settings.collect_grass_freq, 0),
            "rainDetection": bool(getattr(mower_state, "rain_detection", False)),
            "traversalMode": self.to_int(getattr(mower_state, "traversal_mode", 0), 0),
            "turningMode": self.to_int(getattr(mower_state, "turning_mode", 0), 0),
            "cutterMode": self.to_int(getattr(mower_state, "cutter_mode", 0), 0),
            "sideLight": bool(self.to_int(getattr(getattr(mower_state, "side_led", None), "enable", 0), 0)),
            "manualLight": bool(getattr(getattr(mower_state, "lamp_info", None), "manual_light", False)),
            "nightLight": bool(getattr(getattr(mower_state, "lamp_info", None), "night_light", False)),
            "grassCollection": self.to_int(getattr(mower_state, "collect_grass_enable", 0), 0),
            "animalProtectionMode": self.to_int(getattr(getattr(mower_state, "animal_protection", None), "mode", 0), 0),
            "animalProtectionStatus": self.to_int(getattr(getattr(mower_state, "animal_protection", None), "status", 0), 0),
            "selectedAreaHashes": ",".join(str(hash_id) for hash_id in selected_zone_hashes),
            "selectedAreaCount": len(selected_zone_hashes),
            "mapAreaCount": len(getattr(map_data, "area", {}) or {}),
            "planCount": len(getattr(map_data, "plan", {}) or {}),
        }
        configuration_limits = {
            "bladeHeightMin": self.to_int(getattr(getattr(device_limits, "blade_height", None), "min", 0), 0),
            "bladeHeightMax": self.to_int(getattr(getattr(device_limits, "blade_height", None), "max", 0), 0),
            "workingSpeedMin": self.to_float(getattr(getattr(device_limits, "working_speed", None), "min", 0.0), 0.0),
            "workingSpeedMax": self.to_float(getattr(getattr(device_limits, "working_speed", None), "max", 0.0), 0.0),
            "pathSpacingMin": self.to_int(getattr(getattr(device_limits, "path_spacing", None), "min", 0), 0),
            "pathSpacingMax": self.to_int(getattr(getattr(device_limits, "path_spacing", None), "max", 0), 0),
            "maxAreaCount": self.to_int(getattr(device_limits, "work_area_num_max", 0), 0),
        }
        plans = []
        for fallback_index, plan in enumerate((getattr(map_data, "plan", {}) or {}).values(), start=1):
            plan_id = str(getattr(plan, "plan_id", "") or getattr(plan, "id", "") or f"plan-{fallback_index}")
            zone_hashes = [self.to_int(hash_id, 0) for hash_id in getattr(plan, "zone_hashs", []) if self.to_int(hash_id, 0) > 0]
            zone_names = [zone_names_by_hash.get(hash_id, area_names.get(hash_id, str(hash_id))) for hash_id in zone_hashes]
            plan_name = (
                str(getattr(plan, "task_name", "") or "").strip()
                or str(getattr(plan, "job_name", "") or "").strip()
                or f"plan {self.to_int(getattr(plan, 'plan_index', fallback_index), fallback_index)}"
            )
            plans.append(
                {
                    "id": plan_id,
                    "name": plan_name,
                    "info": {
                        "planId": plan_id,
                        "taskId": str(getattr(plan, "task_id", "") or ""),
                        "jobId": str(getattr(plan, "job_id", "") or ""),
                        "taskName": str(getattr(plan, "task_name", "") or ""),
                        "jobName": str(getattr(plan, "job_name", "") or ""),
                        "area": self.to_int(getattr(plan, "area", 0), 0),
                        "requiredTime": self.to_int(getattr(plan, "required_time", 0), 0),
                        "workTime": self.to_int(getattr(plan, "work_time", 0), 0),
                        "planIndex": self.to_int(getattr(plan, "plan_index", fallback_index), fallback_index),
                    },
                    "schedule": {
                        "startTime": str(getattr(plan, "start_time", "") or ""),
                        "endTime": str(getattr(plan, "end_time", "") or ""),
                        "startDate": str(getattr(plan, "start_date", "") or ""),
                        "endDate": str(getattr(plan, "end_date", "") or ""),
                        "week": self.to_int(getattr(plan, "week", 0), 0),
                        "weeks": ",".join(str(self.to_int(week, 0)) for week in getattr(plan, "weeks", []) or []),
                        "day": self.to_int(getattr(plan, "day", 0), 0),
                        "triggerType": self.to_int(getattr(plan, "trigger_type", 0), 0),
                        "remainedSeconds": self.to_int(getattr(plan, "remained_seconds", 0), 0),
                    },
                    "configuration": {
                        "bladeHeight": self.to_int(getattr(plan, "knife_height", 0), 0),
                        "workingSpeed": self.to_float(getattr(plan, "speed", 0.0), 0.0),
                        "pathSpacing": self.to_int(getattr(plan, "route_spacing", 0), 0),
                        "jobMode": self.to_int(getattr(plan, "model", 0), 0),
                        "ultraWave": self.to_int(getattr(plan, "ultrasonic_barrier", 0), 0),
                        "edgeMode": self.to_int(getattr(plan, "edge_mode", 0), 0),
                        "toward": self.to_int(getattr(plan, "route_angle", 0), 0),
                        "towardMode": self.to_int(getattr(plan, "toward_mode", 0), 0),
                        "towardIncludedAngle": self.to_int(getattr(plan, "toward_included_angle", 0), 0),
                        "routeModel": self.to_int(getattr(plan, "route_model", 0), 0),
                    },
                    "zones": {
                        "count": len(zone_hashes),
                        "hashes": ",".join(str(hash_id) for hash_id in zone_hashes),
                        "names": ",".join(zone_names),
                    },
                }
            )
        plans.sort(
            key=lambda item: (
                self.to_int(item.get("info", {}).get("planIndex", 0), 0),
                str(item.get("name", "")).lower(),
            )
        )
        return {
            "id": device_id,
            "name": device.name or device_id,
            "info": {
                "deviceType": device_type.get_model(),
                "productKey": product_key,
                "firmwareVersion": firmware,
                "model": model,
                "serialNumber": serial_number,
                "mqttTransport": mqtt_transport,
            },
            "status": {
                "online": bool(snapshot.online),
                "enabled": bool(snapshot.enabled),
                "connectionState": connection_state,
                "activity": activity,
                "state": str(state_code),
            },
            "telemetry": telemetry,
            "capabilities": capabilities,
            "diagnostics": diagnostics,
            "configuration": configuration,
            "configurationLimits": configuration_limits,
            "zones": zones,
            "plans": plans,
        }

    async def send_command(self, device_id: str, command: str) -> dict[str, Any]:
        if self.client is None:
            raise JsonRpcError("Client is not initialized")

        if command == "start":
            await self.client.send_command_with_args(device_id, "start_job")
        elif command == "pause":
            await self.client.send_command_with_args(device_id, "pause_execute_task")
        elif command == "stop":
            await self.client.send_command_with_args(device_id, "cancel_job")
        elif command == "dock":
            await self.client.send_command_with_args(device_id, "return_to_dock")
        elif command == "leaveDock":
            await self.client.send_command_with_args(device_id, "leave_dock")
        elif command == "cancelTask":
            await self.client.send_command_with_args(device_id, "cancel_job")
        elif command == "nudgeForward":
            await self.client.send_command_with_args(device_id, "move_forward", prefer_ble=False, linear=0.4)
        elif command == "nudgeBack":
            await self.client.send_command_with_args(device_id, "move_back", prefer_ble=False, linear=0.4)
        elif command == "nudgeLeft":
            await self.client.send_command_with_args(device_id, "move_left", prefer_ble=False, angular=0.4)
        elif command == "nudgeRight":
            await self.client.send_command_with_args(device_id, "move_right", prefer_ble=False, angular=0.4)
        elif command == "bladeOn":
            device = self.client.get_device_by_name(device_id)
            if device is None or not DeviceType.is_luba1(device_id, self.get_product_key(device)):
                raise JsonRpcError(f"Blade control is not supported for {device_id}")
            await self.client.send_command_with_args(device_id, "set_blade_control", on_off=1)
        elif command == "bladeOff":
            device = self.client.get_device_by_name(device_id)
            if device is None or not DeviceType.is_luba1(device_id, self.get_product_key(device)):
                raise JsonRpcError(f"Blade control is not supported for {device_id}")
            await self.client.send_command_with_args(device_id, "set_blade_control", on_off=0)
        elif command == "refresh":
            device = self.client.get_device_by_name(device_id)
            if device is not None and not DeviceType.is_rtk(device_id, self.get_product_key(device)):
                for refresh_command in ("get_error_code", "get_error_timestamp", "get_report_cfg", "get_maintenance"):
                    await self.client.send_command_with_args(device_id, refresh_command)
                await asyncio.sleep(2)
            else:
                await self.client.send_command_with_args(
                    device_id,
                    "request_iot_sys",
                    rpt_act=RptAct.RPT_START,
                    rpt_info_type=[
                        RptInfoType.RIT_DEV_STA,
                        RptInfoType.RIT_DEV_LOCAL,
                        RptInfoType.RIT_WORK,
                        RptInfoType.RIT_MAINTAIN,
                        RptInfoType.RIT_BASESTATION_INFO,
                        RptInfoType.RIT_VIO,
                    ],
                    timeout=10000,
                    period=3000,
                    no_change_period=4000,
                    count=1,
                )
        else:
            raise JsonRpcError(f"Unsupported command: {command}")

        await self.persist_cache()
        result = {"ok": True, "device_id": device_id, "command": command}
        await self.emit("command_result", result)
        await self.emit_snapshot(device_id)
        return result

    async def set_setting(self, device_id: str, key: str, value: Any) -> dict[str, Any]:
        if self.client is None:
            raise JsonRpcError("Client is not initialized")

        if key == "bladeHeight":
            await self.client.send_command_with_args(device_id, "set_blade_height", height=self.to_int(value, 0))
        elif key == "workingSpeed":
            await self.client.send_command_with_args(device_id, "set_speed", speed=self.to_float(value, 0.0))
        elif key == "rainDetection":
            await self.client.send_command_with_args(device_id, "read_write_device", rw_id=3, context=int(self.to_bool(value)), rw=1)
        elif key == "traversalMode":
            await self.client.send_command_with_args(device_id, "traverse_mode", context=self.to_int(value, 0))
        elif key == "turningMode":
            await self.client.send_command_with_args(device_id, "turning_mode", context=self.to_int(value, 0))
        elif key == "sideLight":
            await self.client.send_command_with_args(
                device_id,
                "read_and_set_sidelight",
                is_sidelight=self.to_bool(value),
                operate=0,
            )
            await self.client.send_command_with_args(device_id, "read_and_set_sidelight", is_sidelight=False, operate=1)
        elif key == "manualLight":
            await self.client.send_command_with_args(device_id, "set_car_manual_light", manual_ctrl=self.to_bool(value))
            await self.client.send_command_with_args(device_id, "get_car_light", ids=1126)
        elif key == "nightLight":
            await self.client.send_command_with_args(device_id, "set_car_light", on_off=self.to_bool(value))
            await self.client.send_command_with_args(device_id, "get_car_light", ids=1123)
        elif key == "cutterMode":
            await self.client.send_command_with_args(device_id, "set_cutter_mode", cutter_mode=self.to_int(value, 0))
        else:
            raise JsonRpcError(f"Unsupported setting key: {key}")

        await self.persist_cache()
        result = {"ok": True, "device_id": device_id, "command": f"set:{key}"}
        await self.emit("command_result", result)
        await asyncio.sleep(1)
        await self.emit_snapshot(device_id)
        return result

    async def zone_action(self, device_id: str, action: str) -> dict[str, Any]:
        if self.client is None:
            raise JsonRpcError("Client is not initialized")

        if action == "syncMap":
            await self.client.start_map_sync(device_id)
        elif action == "syncAreaNames":
            await self.client.start_area_name_sync(device_id)
        elif action == "syncPlans":
            await self.client.start_plan_sync(device_id)
        else:
            raise JsonRpcError(f"Unsupported zone action: {action}")

        await self.persist_cache()
        result = {"ok": True, "device_id": device_id, "command": action}
        await self.emit("command_result", result)
        await self.emit_snapshot(device_id)
        return result

    async def plan_action(self, device_id: str, action: str, plan_id: str | None = None) -> dict[str, Any]:
        if self.client is None:
            raise JsonRpcError("Client is not initialized")

        if action == "sync":
            await self.client.start_plan_sync(device_id)
        elif action == "start":
            if not plan_id:
                raise JsonRpcError("Missing plan_id for plan start")
            await self.client.send_command_with_args(device_id, "single_schedule", plan_id=plan_id)
            await asyncio.sleep(1)
        else:
            raise JsonRpcError(f"Unsupported plan action: {action}")

        await self.persist_cache()
        result = {
            "ok": True,
            "device_id": device_id,
            "command": f"plan:{action}",
            "message": plan_id or "",
        }
        await self.emit("command_result", result)
        await self.emit_snapshot(device_id)
        return result

    async def start_areas(
        self,
        device_id: str,
        area_hashes: list[Any],
        overrides: dict[str, Any],
        start_immediately: bool,
    ) -> dict[str, Any]:
        if self.client is None:
            raise JsonRpcError("Client is not initialized")

        device = self.client.get_device_by_name(device_id)
        if device is None:
            raise JsonRpcError(f"Unknown device: {device_id}")
        product_key = self.get_product_key(device)
        if DeviceType.is_rtk(device_id, product_key) or DeviceType.is_swimming_pool(device_id):
            raise JsonRpcError(f"Area selection is not supported for {device_id}")

        selected_area_hashes = self.get_area_hashes(device, area_hashes)
        if not selected_area_hashes:
            raise JsonRpcError(f"No area hashes available for {device_id}. Run syncMap first.")

        route_information = self.build_route_information(device_id, device, selected_area_hashes, overrides)
        await self.client.start_mow_path_saga(device_id, zone_hashs=selected_area_hashes, route_info=route_information)
        if start_immediately:
            await self.client.send_command_with_args(device_id, "start_job")

        await self.persist_cache()
        result = {
            "ok": True,
            "device_id": device_id,
            "command": "start_areas",
            "message": ",".join(str(hash_id) for hash_id in selected_area_hashes),
        }
        await self.emit("command_result", result)
        await asyncio.sleep(1)
        await self.emit_snapshot(device_id)
        return result

    async def teardown_client(self) -> None:
        await self.clear_subscriptions()
        if self.client is not None:
            await self.client.stop()
        self.client = None

    async def shutdown(self) -> None:
        await self.teardown_client()


async def main() -> None:
    sidecar = Sidecar()
    while True:
        line = await asyncio.to_thread(sys.stdin.readline)
        if not line:
            break
        request = json.loads(line)
        try:
            await sidecar.handle_request(request)
        except EOFError:
            break


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
