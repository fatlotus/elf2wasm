class CustomAppError(Exception):
    pass


def inner_boom(msg: str) -> None:
    raise CustomAppError(msg)


def outer_call(msg: str) -> None:
    inner_boom(msg)
