def covered_function():
    def inner_func(
        a,
        b,
    ):
        pass

    inner_func(1, 2)

    return 1


def missing_function(a=0):
    def inner_func(
        a,
        b,
    ):
        pass

    pass