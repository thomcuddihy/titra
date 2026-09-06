"""Credential discovery, precedence, validation, and secure configuration writes."""

from __future__ import annotations

import os
import stat
import tomllib
from collections.abc import Callable, Mapping
from contextlib import suppress
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import tomli_w

from .errors import ConfigurationError, CredentialSecurityError
from .models import ResolvedConfig

CONFIG_FILENAME = ".titra-cli.toml"
DEFAULT_TIMEZONE = "Australia/Brisbane"


def _validate_credential_stat(path: Path, file_stat: os.stat_result) -> None:
    if not stat.S_ISREG(file_stat.st_mode):
        raise CredentialSecurityError(f"Credential path is not a regular file: {path}")
    if os.name == "posix":
        if file_stat.st_uid != os.geteuid():
            raise CredentialSecurityError(
                f"Credential file is not owned by the current user: {path}"
            )
        if stat.S_IMODE(file_stat.st_mode) & 0o077:
            raise CredentialSecurityError(
                f"Credential file is accessible by group or other users: {path}. Run chmod 600."
            )


def load_config_file(path: Path) -> dict[str, Any]:
    path = path.expanduser()
    if not path.exists():
        raise ConfigurationError(f"Credential file does not exist: {path}")
    try:
        if path.is_symlink():
            raise CredentialSecurityError(f"Refusing symlinked credential file: {path}")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        file_stat = os.fstat(descriptor)
        _validate_credential_stat(path, file_stat)
        with os.fdopen(descriptor, "rb") as handle:
            value = tomllib.load(handle)
    except CredentialSecurityError:
        raise
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise ConfigurationError(f"Cannot read credential file {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ConfigurationError(f"Credential file must contain a TOML table: {path}")
    return value


def _available_config_files(*, cwd: Path, home: Path) -> list[tuple[Path, dict[str, Any]]]:
    """Load implicit files in precedence order without ever merging their secrets."""

    values: list[tuple[Path, dict[str, Any]]] = []
    seen: set[Path] = set()
    for candidate in (cwd / CONFIG_FILENAME, home / CONFIG_FILENAME):
        normalized = candidate.expanduser().absolute()
        if normalized in seen or not normalized.exists():
            continue
        seen.add(normalized)
        values.append((normalized, load_config_file(normalized)))
    return values


def _clean_optional(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip()
    return cleaned or None


def _validate_server(server: str, *, allow_insecure_http: bool = False) -> str:
    normalized = server.strip().rstrip("/")
    parsed = urlparse(normalized)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ConfigurationError("Titra server must be an absolute http:// or https:// URL.")
    if parsed.username or parsed.password:
        raise ConfigurationError("Do not embed credentials in the Titra server URL.")
    if parsed.query or parsed.fragment:
        raise ConfigurationError("The Titra server URL cannot contain a query string or fragment.")
    hostname = parsed.hostname or ""
    loopback_names = {"localhost", "127.0.0.1", "::1"}
    if parsed.scheme == "http" and hostname not in loopback_names and not allow_insecure_http:
        raise ConfigurationError(
            "Refusing to send an API key over non-loopback HTTP. "
            "Use HTTPS or explicitly use --insecure."
        )
    return normalized


def validate_server_url(server: str, *, allow_insecure_http: bool = False) -> str:
    """Validate a Titra base URL for separately authenticated integrations."""

    return _validate_server(server, allow_insecure_http=allow_insecure_http)


def _validate_timezone(name: str) -> str:
    try:
        ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise ConfigurationError(f"Unknown IANA timezone: {name}") from exc
    return name


def resolve_config(
    *,
    profile: str | None = None,
    server: str | None = None,
    api_key: str | None = None,
    username: str | None = None,
    timezone: str | None = None,
    explicit_file: Path | None = None,
    verify_tls: bool = True,
    timeout: float = 20.0,
    environ: Mapping[str, str] | None = None,
    cwd: Path | None = None,
    home: Path | None = None,
    interactive: bool = False,
    prompt_text: Callable[[str], str] | None = None,
    prompt_secret: Callable[[str], str] | None = None,
) -> ResolvedConfig:
    """Resolve settings with flags > environment > explicit/cwd/home file precedence."""

    env = os.environ if environ is None else environ
    current = Path.cwd() if cwd is None else cwd
    user_home = Path.home() if home is None else home

    trusted_server = (
        _clean_optional(server)
        or _clean_optional(env.get("TITRA_SERVER"))
        or _clean_optional(env.get("TITRA_URL"))
    )
    env_key = env.get("TITRA_API_KEY") or env.get("TITRA_API_TOKEN")
    trusted_key = _clean_optional(api_key) or _clean_optional(env_key)

    if bool(trusted_server) != bool(trusted_key) and not interactive:
        raise ConfigurationError(
            "For safety, provide both server and API key through flags/environment, "
            "or provide neither and use one complete credential profile."
        )

    if explicit_file is not None:
        config_path = explicit_file.expanduser().absolute()
        config_files = [(config_path, load_config_file(config_path))]
    elif trusted_server or trusted_key:
        # Explicit process values are a complete trusted source (or will be completed
        # by interactive prompts). Do not even inspect an untrusted working directory.
        config_files = []
    else:
        config_files = _available_config_files(cwd=current, home=user_home)

    first_file_default = next(
        (
            _clean_optional(value.get("default_profile"))
            for _path, value in config_files
            if _clean_optional(value.get("default_profile"))
        ),
        None,
    )
    selected_profile = (
        _clean_optional(profile)
        or _clean_optional(env.get("TITRA_PROFILE"))
        or first_file_default
        or "default"
    )
    candidate_profiles: list[tuple[Path, dict[str, Any]]] = []
    for path, config_data in config_files:
        profiles = config_data.get("profiles", {})
        if profiles is not None and not isinstance(profiles, dict):
            raise ConfigurationError(f"The TOML 'profiles' value must be a table in {path}.")
        file_profile = profiles.get(selected_profile, {}) if isinstance(profiles, dict) else {}
        if file_profile and not isinstance(file_profile, dict):
            raise ConfigurationError(
                f"Profile {selected_profile!r} must be a TOML table in {path}."
            )
        if isinstance(file_profile, dict) and file_profile:
            candidate_profiles.append((path, file_profile))

    source_profile: dict[str, Any] = {}
    source_files: tuple[Path, ...] = ()
    if trusted_server and trusted_key:
        resolved_server = trusted_server
        resolved_key = trusted_key
        if candidate_profiles:
            source_files = (candidate_profiles[0][0],)
            source_profile = candidate_profiles[0][1]
    else:
        if candidate_profiles:
            highest_path, highest_profile = candidate_profiles[0]
            if not (
                _clean_optional(highest_profile.get("server"))
                and _clean_optional(highest_profile.get("api_key"))
            ):
                raise ConfigurationError(
                    f"Profile {selected_profile!r} is incomplete in higher-precedence file "
                    f"{highest_path}; refusing to combine credential sources."
                )
        complete_source = next(
            (
                (path, value)
                for path, value in candidate_profiles
                if _clean_optional(value.get("server")) and _clean_optional(value.get("api_key"))
            ),
            None,
        )
        if complete_source is None:
            resolved_server = None
            resolved_key = None
        else:
            source_files = (complete_source[0],)
            source_profile = complete_source[1]
            resolved_server = _clean_optional(source_profile.get("server"))
            resolved_key = _clean_optional(source_profile.get("api_key"))

    resolved_username = (
        _clean_optional(username)
        or _clean_optional(env.get("TITRA_USERNAME"))
        or _clean_optional(source_profile.get("username"))
    )
    resolved_timezone = (
        _clean_optional(timezone)
        or _clean_optional(env.get("TITRA_TIMEZONE"))
        or _clean_optional(source_profile.get("timezone"))
        or DEFAULT_TIMEZONE
    )

    if interactive:
        if resolved_server is None:
            if prompt_text is None:
                raise ConfigurationError("Interactive server prompt is unavailable.")
            resolved_server = _clean_optional(prompt_text("Titra server URL"))
        if resolved_key is None:
            if prompt_secret is None:
                raise ConfigurationError("Interactive API-key prompt is unavailable.")
            resolved_key = _clean_optional(prompt_secret("Titra API key"))

    if resolved_server is None:
        raise ConfigurationError(
            "Missing Titra server URL. Use --server, TITRA_SERVER, or a credential file."
        )
    if resolved_key is None:
        raise ConfigurationError(
            "Missing Titra API key. Use --api-key, TITRA_API_KEY, or a credential file."
        )
    if any(character.isspace() for character in resolved_key):
        raise ConfigurationError("The Titra API key cannot contain whitespace.")
    if timeout <= 0:
        raise ConfigurationError("Timeout must be greater than zero.")

    return ResolvedConfig(
        profile=selected_profile,
        server=_validate_server(resolved_server, allow_insecure_http=not verify_tls),
        api_key=resolved_key,
        username=resolved_username,
        timezone=_validate_timezone(resolved_timezone),
        verify_tls=verify_tls,
        timeout=timeout,
        source_files=source_files,
    )


def write_profile(
    path: Path,
    *,
    profile: str,
    server: str,
    api_key: str,
    username: str | None,
    timezone: str,
    make_default: bool = True,
    overwrite_profile: bool = False,
    allow_insecure_http: bool = False,
) -> None:
    """Create or update one named profile using an atomic, private file replacement."""

    destination = path.expanduser().absolute()
    existing: dict[str, Any] = {}
    if destination.exists():
        existing = load_config_file(destination)
    profiles = existing.setdefault("profiles", {})
    if not isinstance(profiles, dict):
        raise ConfigurationError("The TOML 'profiles' value must be a table.")
    if profile in profiles and not overwrite_profile:
        raise ConfigurationError(
            f"Profile {profile!r} already exists in {destination}; use --force to replace it."
        )
    profile_value: dict[str, Any] = {
        "server": _validate_server(server, allow_insecure_http=allow_insecure_http),
        "api_key": api_key.strip(),
        "timezone": _validate_timezone(timezone),
    }
    if username:
        profile_value["username"] = username.strip()
    profiles[profile] = profile_value
    if make_default:
        existing["default_profile"] = profile

    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp-{os.getpid()}")
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        descriptor = os.open(temporary, flags, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(tomli_w.dumps(existing).encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        if os.name == "posix":
            destination.chmod(0o600)
    except OSError as exc:
        with suppress(OSError):
            temporary.unlink(missing_ok=True)
        raise ConfigurationError(
            f"Cannot securely write credential file {destination}: {exc}"
        ) from exc
